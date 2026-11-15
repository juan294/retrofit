import type { Page, Route } from "@playwright/test";

export interface ChatMessage {
  role: string;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
}
export interface ChatBody {
  model: string;
  messages: ChatMessage[];
  tools?: { type: string; function: { name: string; description?: string } }[];
  stream?: boolean;
}
export type Turn = { text: string } | { call: { name: string; args: Record<string, unknown> }[] };
export type Script = (body: ChatBody, ctx: { n: number }) => Turn;

export interface MockRouter {
  readonly bodies: ChatBody[];
  readonly authorizations: string[];
  readonly modelRequests: number;
}

/** Tool names offered to the model in this request. */
export const toolNames = (b: ChatBody) => (b.tools ?? []).map((t) => t.function.name);
/** The system instructions of the agent making this request. */
export const systemText = (b: ChatBody) => b.messages.find((m) => m.role === "system")?.content ?? "";
/** The latest message, and the latest tool result when it is one. */
export const last = (b: ChatBody) => b.messages[b.messages.length - 1]!;
export const lastToolResult = (b: ChatBody) => (last(b).role === "tool" ? (last(b).content ?? "") : null);

function sse(turn: Turn, model: string): string {
  const chunks: unknown[] = [];
  if ("text" in turn) {
    chunks.push({ model, choices: [{ index: 0, delta: { role: "assistant", content: turn.text } }] });
    chunks.push({ model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  } else {
    chunks.push({
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: turn.call.map((c, i) => ({ index: i, id: `call_${Date.now()}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
          },
        },
      ],
    });
    chunks.push({ model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  }
  chunks.push({ model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

/**
 * Scripted OpenAI-compatible router at `routerBase` (for example https://api.otari.ai/api/v1),
 * intercepted inside the test browser. `/models` lists `model`; `/chat/completions` answers
 * with the script's turn as SSE. Every request body and Authorization header is recorded.
 */
export async function installMockRouter(page: Page, o: { routerBase: string; model: string; script: Script }): Promise<MockRouter> {
  const state = { bodies: [] as ChatBody[], authorizations: [] as string[], modelRequests: 0 };
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
  // The runtime probes `<router origin>/agent-manifest.json` once per boot (engine.js:41-52).
  // Answer it here so no test ever reaches the real provider host.
  await page.route(`${new URL(o.routerBase).origin}/agent-manifest.json`, (route: Route) =>
    route.fulfill({ status: 404, headers: cors, body: "not found" }),
  );
  await page.route(`${o.routerBase}/**`, async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    state.authorizations.push(req.headers()["authorization"] ?? "");
    const path = new URL(req.url()).pathname;
    if (req.method() === "GET" && path.endsWith("/models")) {
      state.modelRequests++;
      return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ object: "list", data: [{ id: o.model, object: "model" }] }) });
    }
    if (req.method() === "POST" && path.endsWith("/chat/completions")) {
      const body = JSON.parse(req.postData() ?? "{}") as ChatBody;
      state.bodies.push(body);
      const turn = o.script(body, { n: state.bodies.length });
      return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: sse(turn, o.model) });
    }
    return route.fulfill({ status: 404, headers: cors, body: "not found" });
  });
  return state;
}
