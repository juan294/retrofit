import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

/** Port of the performance test server (Archy port list). */
export const PERF_PORT = 3014;
export const PERF_ORIGIN = `http://127.0.0.1:${PERF_PORT}`;
const PID_FILE = ".local/perf-server.pid";

async function waitReady(deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${PERF_ORIGIN}/bot`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`perf server on ${PERF_PORT} did not become ready`);
}

/** Starts `next start` on 3014 from the existing build (it builds nothing) and stops that pid at teardown. */
export default async function setup() {
  if (!existsSync(".next/BUILD_ID")) throw new Error("Run pnpm build before pnpm test:perf.");
  const child: ChildProcess = spawn("node_modules/.bin/next", ["start", "--port", String(PERF_PORT), "--hostname", "127.0.0.1"], {
    env: { ...process.env, RETROFIT_TEST_FIXTURES: "1", PUBLIC_ORIGIN: PERF_ORIGIN, NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  mkdirSync(".local", { recursive: true });
  writeFileSync(PID_FILE, String(child.pid));
  await waitReady(Date.now() + 60_000);
  return async () => {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    rmSync(PID_FILE, { force: true });
  };
}
