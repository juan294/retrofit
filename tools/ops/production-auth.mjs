// Shows or applies supabase/production-auth.toml (read its header). The Supabase CLI reads `supabase/config.toml` of a
// directory, so this copies the file and the email template into a new temporary one.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PROJECT = "uqsiliezqcyzpmbvuruh";

/**
 * @param {string[]} argv
 * @param {{ stdout?: (s: string) => void, env?: Record<string, string | undefined> }} [io]
 * @returns {number} the exit status
 */
export function main(argv, io = {}) {
  const say = io.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const apply = argv.includes("--apply");
  if (argv.some((a) => a !== "--apply" && a !== `--project=${PROJECT}`)) {
    say(`Usage: node tools/ops/production-auth.mjs [--apply --project=${PROJECT}]`);
    return 2;
  }
  if (apply && !argv.includes(`--project=${PROJECT}`)) {
    say(`Refused: --apply changes production. Show the difference first, then name the project: --apply --project=${PROJECT}`);
    return 2;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retrofit-auth-"));
  try {
    fs.mkdirSync(path.join(dir, "supabase", "templates"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "supabase/production-auth.toml"), path.join(dir, "supabase/config.toml"));
    fs.copyFileSync(path.join(ROOT, "supabase/templates/magic_link.html"), path.join(dir, "supabase/templates/magic_link.html"));
    const args = ["config", apply ? "push" : "diff", `--remote=${PROJECT}`, ...(apply ? ["--yes"] : []), "--workdir", dir];
    const r = spawnSync("supabase", args, { encoding: "utf8", timeout: 120_000 });
    say(`$ supabase ${args.slice(0, -1).join(" ")} <temporary copy of supabase/production-auth.toml>`);
    say(`${r.stdout ?? ""}${r.stderr ?? ""}`.trim());
    return typeof r.status === "number" ? r.status : 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
