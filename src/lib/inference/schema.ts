import type { FreeConfig } from "@/lib/config";

/**
 * Request schema for Retrofit's free path (phase 6, "Request schema"). It accepts
 * exactly what the vendored runtime sends (`runtime/llm.js:85-93`,
 * `runtime/runner.js:576-586`, `:120-133`) and refuses everything else, so no
 * field that changes cost or output shape (n, logprobs, response_format,
 * stream_options, max_tokens) reaches the provider. Refusal messages are plain
 * text the runtime shows in chat; the proxy wraps them in the OpenAI error shape.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string | null }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string | null };

export interface ToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none";
  stream?: boolean;
  temperature?: number;
  top_p?: number;
}

export type ParseResult = { ok: true; body: ChatRequest } | { ok: false; status: 400; message: string };

/** Tool result names (plan: `^[A-Za-z0-9_]{1,64}$`). */
const TOOL_RESULT_NAME = /^[A-Za-z0-9_]{1,64}$/;
/** Function names in tool definitions and tool calls (the provider's own rule, which also allows "-"). */
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const TOP_LEVEL = new Set(["model", "messages", "tools", "tool_choice", "stream", "temperature", "top_p"]);
/** A Map, so a role is never found through the prototype chain ("__proto__", "toString"). */
const MESSAGE_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["system", new Set(["role", "content"])],
  ["user", new Set(["role", "content"])],
  ["assistant", new Set(["role", "content", "tool_calls"])],
  ["tool", new Set(["role", "tool_call_id", "name", "content"])],
]);

class Refusal extends Error {}

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** Own properties only: an inherited name never counts as a field the caller sent. */
const has = (o: Obj, key: string): boolean => Object.hasOwn(o, key);
const utf8Bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

function refuse(message: string): never {
  throw new Refusal(message);
}

function onlyKeys(value: Obj, allowed: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) refuse(`Field "${key}" in ${where} is not accepted by Retrofit's free AI.`);
  }
}

function content(m: Obj, where: string): string | null {
  if (!has(m, "content")) refuse(`${where} needs a content field.`);
  const c = m.content;
  if (c !== null && typeof c !== "string") refuse(`${where} content must be text. Images, audio and files are not accepted.`);
  return c;
}

function nonEmptyString(v: unknown, field: string, where: string): string {
  if (typeof v !== "string" || v.length === 0) refuse(`${where} needs a non-empty ${field}.`);
  return v;
}

function parseToolCall(v: unknown, where: string): ToolCall {
  if (!isObject(v)) refuse(`${where} must be an object.`);
  onlyKeys(v, new Set(["id", "type", "function"]), where);
  const id = nonEmptyString(v.id, "id", where);
  if (v.type !== "function") refuse(`${where} type must be "function".`);
  const fn = v.function;
  if (!isObject(fn)) refuse(`${where} needs a function object.`);
  onlyKeys(fn, new Set(["name", "arguments"]), `${where} function`);
  if (typeof fn.name !== "string" || !FUNCTION_NAME.test(fn.name)) refuse(`${where} function name is not valid.`);
  if (typeof fn.arguments !== "string") refuse(`${where} function arguments must be a string.`);
  return { id, type: "function", function: { name: fn.name, arguments: fn.arguments } };
}

function parseMessages(v: unknown, max: number): ChatMessage[] {
  if (!Array.isArray(v) || v.length === 0) refuse("messages must be a non-empty list.");
  if (v.length > max) refuse(`Too many messages: at most ${max} are accepted.`);
  const calledNames = new Set<string>();
  return v.map((m, i): ChatMessage => {
    const where = `message ${i + 1}`;
    if (!isObject(m)) refuse(`${where} must be an object.`);
    const role = m.role;
    const allowed = typeof role === "string" ? MESSAGE_KEYS.get(role) : undefined;
    if (typeof role !== "string" || !allowed) refuse(`${where} role must be system, user, assistant or tool.`);
    onlyKeys(m, allowed, where);
    const text = content(m, where);
    if (role === "system" || role === "user") return { role, content: text };
    if (role === "assistant") {
      if (!has(m, "tool_calls")) return { role, content: text };
      if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) refuse(`${where} tool_calls must be a non-empty list.`);
      const calls = m.tool_calls.map((c, j) => parseToolCall(c, `${where} tool call ${j + 1}`));
      for (const c of calls) calledNames.add(c.function.name);
      return { role, content: text, tool_calls: calls };
    }
    const toolCallId = nonEmptyString(m.tool_call_id, "tool_call_id", where);
    if (typeof m.name !== "string" || !TOOL_RESULT_NAME.test(m.name)) refuse(`${where} needs a tool name of letters, digits and underscores (at most 64).`);
    if (!calledNames.has(m.name)) refuse(`${where} answers tool "${m.name}", which no earlier tool call in this request used.`);
    return { role: "tool", tool_call_id: toolCallId, name: m.name, content: text };
  });
}

function parseTools(v: unknown, free: FreeConfig): ToolDefinition[] {
  if (!Array.isArray(v)) refuse("tools must be a list.");
  if (v.length > free.maxTools) refuse(`Too many tools: at most ${free.maxTools} are accepted.`);
  return v.map((t, i): ToolDefinition => {
    const where = `tool ${i + 1}`;
    if (!isObject(t)) refuse(`${where} must be an object.`);
    onlyKeys(t, new Set(["type", "function"]), where);
    if (t.type !== "function") refuse(`${where} type must be "function".`);
    const fn = t.function;
    if (!isObject(fn)) refuse(`${where} needs a function object.`);
    onlyKeys(fn, new Set(["name", "description", "parameters"]), `${where} function`);
    if (typeof fn.name !== "string" || !FUNCTION_NAME.test(fn.name)) refuse(`${where} function name is not valid.`);
    const out: ToolDefinition = { type: "function", function: { name: fn.name } };
    if (has(fn, "description")) {
      if (typeof fn.description !== "string") refuse(`${where} description must be text.`);
      out.function.description = fn.description;
    }
    if (has(fn, "parameters")) {
      if (!isObject(fn.parameters)) refuse(`${where} parameters must be a JSON object.`);
      out.function.parameters = fn.parameters;
    }
    if (utf8Bytes(t) > free.maxToolBytes) refuse(`${where} is larger than ${free.maxToolBytes} bytes.`);
    return out;
  });
}

function numberIn(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) refuse(`${field} must be a number from ${min} to ${max}.`);
  return v;
}

export function parseChatRequest(json: unknown, free: FreeConfig): ParseResult {
  try {
    if (!isObject(json)) refuse("The request body must be a JSON object.");
    onlyKeys(json, TOP_LEVEL, "the request");
    if (utf8Bytes(json) > free.maxBodyBytes) refuse(`The request is larger than ${free.maxBodyBytes} bytes.`);
    if (json.model !== free.model) refuse(`Retrofit's free AI serves only the model "${free.model}".`);
    const body: ChatRequest = { model: free.model, messages: parseMessages(json.messages, free.maxMessages) };
    if (has(json, "tools")) body.tools = parseTools(json.tools, free);
    if (has(json, "tool_choice")) {
      if (json.tool_choice !== "auto" && json.tool_choice !== "none") refuse('tool_choice must be "auto" or "none".');
      body.tool_choice = json.tool_choice;
    }
    if (has(json, "stream")) {
      if (typeof json.stream !== "boolean") refuse("stream must be true or false.");
      body.stream = json.stream;
    }
    if (has(json, "temperature")) body.temperature = numberIn(json.temperature, "temperature", 0, 2);
    if (has(json, "top_p")) body.top_p = numberIn(json.top_p, "top_p", 0, 1);
    return { ok: true, body };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, status: 400, message: error.message };
    throw error;
  }
}
