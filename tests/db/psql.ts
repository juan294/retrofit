/** psql helpers of the race tests: the interleaving of two calls is fixed through a held lock, not raced. */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const dbUrl = process.env.SUPABASE_GATE_DB_URL;
const run = promisify(execFile);

function requireDbUrl(): string {
  if (!dbUrl) throw new Error("The race tests need the disposable gate stack. Run them through pnpm test:db.");
  return dbUrl;
}

/** The trimmed output of one SQL statement. */
export const query = async (sql: string): Promise<string> => (await run("psql", [requireDbUrl(), "-X", "-At", "-c", sql], { timeout: 10_000 })).stdout.trim();

/** Runs `sql` in an open transaction and keeps its locks until `release` commits it; `pid` is the holding session. */
export async function holdTransaction(sql: string): Promise<{ pid: string; release: () => Promise<void> }> {
  const psql = spawn("psql", [requireDbUrl(), "-X", "-At", "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve) => psql.once("exit", () => resolve()));
  const held = new Promise<string>((resolve) => {
    let out = "";
    psql.stdout.on("data", (chunk) => {
      out += String(chunk);
      const pid = /held (\d+)/.exec(out)?.[1];
      if (pid) resolve(pid);
    });
  });
  psql.stdin.write(`begin;\n${sql};\nselect 'held ' || pg_backend_pid();\n`);
  const pid = await held;
  return {
    pid,
    release: async () => {
      psql.stdin.end("commit;\n\\q\n");
      await exited;
    },
  };
}

/** Waits until a session waits for a lock of session `pid`, and returns that waiting session (other tests' waits do not count). */
export async function waiterOf(pid: string): Promise<string> {
  const until = Date.now() + 8_000;
  for (;;) {
    const waiting = await query(`select pid from pg_stat_activity where ${pid} = any (pg_blocking_pids(pid)) limit 1`);
    if (waiting) return waiting;
    if (Date.now() > until) throw new Error(`no session waits for session ${pid}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
