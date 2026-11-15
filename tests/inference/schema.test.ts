import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFreeConfig } from "@/lib/config";
import { parseChatRequest } from "@/lib/inference/schema";

const free = loadFreeConfig({}, false);
const MODEL = free.model;
const fixturesDir = fileURLToPath(new URL("../fixtures/runtime-requests/", import.meta.url));

type Json = Record<string, unknown>;

const tool = (name: string, extra: Json = {}): Json => ({
  type: "function",
  function: { name, description: "Does a thing.", parameters: { type: "object", properties: {} }, ...extra },
});

const base = (): Json => ({
  model: MODEL,
  messages: [
    { role: "system", content: "You help." },
    { role: "user", content: "Hello" },
  ],
  stream: true,
  tools: [tool("lookup")],
  tool_choice: "auto",
});

const withToolTurn = (toolMessage: Json): Json => ({
  ...base(),
  messages: [
    { role: "user", content: "Hours?" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    toolMessage,
  ],
});

function expectRejected(json: unknown, pattern?: RegExp) {
  const r = parseChatRequest(json, free);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.status).toBe(400);
  expect(r.message.length).toBeGreaterThan(0);
  if (pattern) expect(r.message).toMatch(pattern);
}

describe("parseChatRequest", () => {
  // Fails if the schema rejects any field the vendored runtime sends (fact 19 gate).
  it("accepts every body captured from the vendored runtime", () => {
    const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    let count = 0;
    for (const file of files) {
      const { bodies } = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), "utf8")) as { bodies: unknown[] };
      for (const body of bodies) {
        const r = parseChatRequest(body, free);
        expect(r, `${file} body ${count}`).toEqual({ ok: true, body });
        count++;
      }
    }
    expect(count).toBeGreaterThanOrEqual(4);
  });

  // Fails if optional sampling fields from the allowlist are refused.
  it("accepts temperature and top_p", () => {
    const r = parseChatRequest({ ...base(), temperature: 0.2, top_p: 0.9 }, free);
    expect(r.ok).toBe(true);
  });

  // Fails if the returned body carries fields other than the validated ones (it is the upstream source).
  it("returns a copy, not the caller's object", () => {
    const json = base();
    const r = parseChatRequest(json, free);
    expect(r.ok && r.body).not.toBe(json);
  });

  // Fails if any field outside the top-level allowlist is forwarded.
  it.each(["n", "logprobs", "response_format", "stream_options", "max_tokens", "user", "seed"])("rejects top-level field %s", (field) => {
    expectRejected({ ...base(), [field]: 1 }, new RegExp(field));
  });

  // Fails if a body that is not a JSON object passes.
  it.each([null, [], "text", 3])("rejects a non-object body %j", (json) => {
    expectRejected(json);
  });

  // Fails if another model can be selected through the free path.
  it("rejects a model other than the free model, and a missing model", () => {
    expectRejected({ ...base(), model: "openai/gpt-5" }, /model/i);
    const { model: _model, ...rest } = base();
    expectRejected(rest, /model/i);
  });

  // Fails if empty or oversized message lists pass.
  it("rejects missing, empty and too many messages", () => {
    expectRejected({ ...base(), messages: [] });
    expectRejected({ ...base(), messages: "hi" });
    const many = Array.from({ length: free.maxMessages + 1 }, () => ({ role: "user", content: "x" }));
    expectRejected({ ...base(), messages: many }, /messages/i);
    expect(parseChatRequest({ ...base(), messages: many.slice(1) }, free).ok).toBe(true);
  });

  // Fails if array content (images, audio, file parts) is accepted.
  it("rejects array content and image parts", () => {
    expectRejected({ ...base(), messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, /content/i);
    expectRejected({ ...base(), messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] }, /content/i);
    expectRejected({ ...base(), messages: [{ role: "user", content: 7 }] }, /content/i);
  });

  // Fails if unknown roles are accepted.
  it.each(["developer", "function", "admin", ""])("rejects role %j", (role) => {
    expectRejected({ ...base(), messages: [{ role, content: "x" }] }, /role/i);
  });

  // Fails if extra keys in a message are forwarded.
  it("rejects extra keys in messages", () => {
    expectRejected({ ...base(), messages: [{ role: "user", content: "x", name: "bob" }] }, /name/);
    expectRejected({ ...base(), messages: [{ role: "system", content: "x", tool_calls: [] }] }, /tool_calls/);
  });

  // Fails if malformed assistant tool calls or extra keys in them pass.
  it("rejects malformed tool calls and extra keys in tool calls", () => {
    const call = { id: "c", type: "function", function: { name: "lookup", arguments: "{}" } };
    const turn = (c: unknown): Json => ({ ...base(), messages: [{ role: "assistant", content: null, tool_calls: [c] }] });
    expect(parseChatRequest(turn(call), free).ok).toBe(true);
    expectRejected(turn({ ...call, extra: 1 }), /extra/);
    expectRejected(turn({ ...call, function: { ...call.function, extra: 1 } }), /extra/);
    expectRejected(turn({ ...call, type: "code" }));
    expectRejected(turn({ ...call, function: { ...call.function, arguments: {} } }), /arguments/);
    expectRejected(turn({ ...call, id: "" }));
    expectRejected({ ...base(), messages: [{ role: "assistant", content: null, tool_calls: "x" }] });
  });

  // Fails if a tool result without a valid name, or with a name no earlier call used, passes.
  it("rejects a tool message whose name is malformed or matches no earlier tool call", () => {
    expect(parseChatRequest(withToolTurn({ role: "tool", tool_call_id: "call_1", name: "lookup", content: "ok" }), free).ok).toBe(true);
    expectRejected(withToolTurn({ role: "tool", tool_call_id: "call_1", name: "look-up", content: "ok" }), /name/);
    expectRejected(withToolTurn({ role: "tool", tool_call_id: "call_1", name: "a".repeat(65), content: "ok" }), /name/);
    expectRejected(withToolTurn({ role: "tool", tool_call_id: "call_1", name: "other_tool", content: "ok" }), /other_tool/);
    expectRejected(withToolTurn({ role: "tool", tool_call_id: "call_1", content: "ok" }), /name/);
    expectRejected(withToolTurn({ role: "tool", name: "lookup", content: "ok" }), /tool_call_id/);
    expectRejected(withToolTurn({ role: "tool", tool_call_id: "call_1", name: "lookup", content: "ok", extra: true }), /extra/);
  });

  // Fails if a tool result can name a call that only appears after it.
  it("rejects a tool message that precedes its tool call", () => {
    const json = {
      ...base(),
      messages: [
        { role: "tool", tool_call_id: "call_1", name: "lookup", content: "early" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      ],
    };
    expectRejected(json, /lookup/);
  });

  // Fails if malformed tools, extra keys in tools, too many tools or oversized tools pass.
  it("rejects malformed, extra-key, too many and oversized tools", () => {
    expectRejected({ ...base(), tools: [{ ...tool("a"), extra: 1 }] }, /extra/);
    expectRejected({ ...base(), tools: [tool("a", { strict: true })] }, /strict/);
    expectRejected({ ...base(), tools: [{ type: "retrieval", function: { name: "a" } }] });
    expectRejected({ ...base(), tools: [tool("a", { parameters: "x" })] }, /parameters/);
    expectRejected({ ...base(), tools: [tool("a", { parameters: [] })] }, /parameters/);
    expectRejected({ ...base(), tools: [tool("bad name!")] }, /name/);
    expectRejected({ ...base(), tools: "x" });
    const many = Array.from({ length: free.maxTools + 1 }, (_, i) => tool(`t${i}`));
    expectRejected({ ...base(), tools: many }, /tools/i);
    expect(parseChatRequest({ ...base(), tools: many.slice(1) }, free).ok).toBe(true);
    // One tool just over the per-tool limit (serialized UTF-8 bytes).
    const fixed = Buffer.byteLength(JSON.stringify(tool("big", { description: "" })));
    const big = tool("big", { description: "é".repeat(Math.ceil((free.maxToolBytes - fixed + 1) / 2)) });
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(free.maxToolBytes);
    expect("é".repeat(Math.ceil((free.maxToolBytes - fixed + 1) / 2)).length).toBeLessThan(free.maxToolBytes - fixed);
    expectRejected({ ...base(), tools: [big] }, /bytes/);
  });

  // Fails if tool_choice values other than "auto" and "none" pass.
  it("accepts only auto and none for tool_choice", () => {
    expect(parseChatRequest({ ...base(), tool_choice: "none" }, free).ok).toBe(true);
    expectRejected({ ...base(), tool_choice: "required" }, /tool_choice/);
    expectRejected({ ...base(), tool_choice: { type: "function", function: { name: "lookup" } } }, /tool_choice/);
  });

  // Fails if wrongly typed optional fields pass.
  it("rejects wrongly typed stream, temperature and top_p", () => {
    expectRejected({ ...base(), stream: "yes" }, /stream/);
    expectRejected({ ...base(), temperature: "hot" }, /temperature/);
    expectRejected({ ...base(), temperature: 5 }, /temperature/);
    expectRejected({ ...base(), top_p: 2 }, /top_p/);
  });

  // Fails if a body above the byte limit passes.
  it("rejects a body above maxBodyBytes", () => {
    const json = { ...base(), messages: [{ role: "user", content: "x".repeat(free.maxBodyBytes) }] };
    expectRejected(json, /bytes/);
  });
});
