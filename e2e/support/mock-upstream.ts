import type { IncomingMessage, ServerResponse } from "node:http";
import { previewScript } from "./agent";
import { callerScript } from "./caller";
import { sse, toolNames, type ChatBody } from "./mock-router";

/** Path of the mock Otari API on the 3013 test server (host 127.0.0.1). FREE_UPSTREAM_URL points here. */
export const UPSTREAM_PATH = "/otari/v1";
export const UPSTREAM_BASE = `http://127.0.0.1:3013${UPSTREAM_PATH}`;
export const UPSTREAM_MODEL = "alibaba/qwen3.8-flash";
/** A visitor message containing this word makes the mock send part of an answer and then break the stream. */
export const PARTIAL_TRIGGER = "free-partial";

interface LogEntry {
  readonly path: string;
  readonly authorization: string;
  readonly cookie: string;
  readonly body: ChatBody | null;
}
const log: LogEntry[] = [];

const userText = (b: ChatBody) => [...b.messages].reverse().find((m) => m.role === "user")?.content ?? "";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Route handlers for startFixtureServer: the mock upstream plus a log the specs read and reset. */
export function upstreamRoutes() {
  return {
    [`${UPSTREAM_PATH}/models`]: (req: IncomingMessage, res: ServerResponse) => {
      log.push({ path: "models", authorization: req.headers.authorization ?? "", cookie: req.headers.cookie ?? "", body: null });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: UPSTREAM_MODEL }] }));
    },
    [`${UPSTREAM_PATH}/chat/completions`]: async (req: IncomingMessage, res: ServerResponse) => {
      const body = JSON.parse(await readBody(req)) as ChatBody;
      log.push({ path: "chat", authorization: req.headers.authorization ?? "", cookie: req.headers.cookie ?? "", body });
      if (userText(body).includes(PARTIAL_TRIGGER)) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "PARTIAL ANSWER THAT MUST NOT SHOW" } }] })}\n\n`);
        setTimeout(() => res.destroy(), 50);
        return;
      }
      const preview = toolNames(body).includes("content_specialist") || /snapshot|content_specialist/.test(body.messages[0]?.content ?? "");
      const turn = (preview ? previewScript : callerScript)(body);
      res.writeHead(200, { "content-type": "text/event-stream" }).end(sse(turn, UPSTREAM_MODEL));
    },
    "/otari/_log": (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(log));
    },
    "/otari/_reset": (_req: IncomingMessage, res: ServerResponse) => {
      log.length = 0;
      res.writeHead(204).end();
    },
  };
}

export async function upstreamLog(): Promise<LogEntry[]> {
  return (await fetch("http://127.0.0.1:3013/otari/_log")).json() as Promise<LogEntry[]>;
}
export async function resetUpstreamLog(): Promise<void> {
  await fetch("http://127.0.0.1:3013/otari/_reset");
}
