/** DO-M1: production Auth settings are versioned apart from the local stacks' ones, and nothing changes production by accident. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:child_process")>()), spawnSync }));
const { main, PROJECT } = await import("../../tools/ops/production-auth.mjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");
const settings = read("supabase/production-auth.toml").replace(/^\s*#.*$/gm, "");

beforeEach(() => {
  spawnSync.mockReset();
  spawnSync.mockReturnValue({ status: 0, stdout: "diff", stderr: "" });
});
const run = (...argv: string[]) => {
  const lines: string[] = [];
  return { code: main(argv, { stdout: (s: string) => lines.push(s) }), out: lines.join("\n") };
};

describe("supabase/production-auth.toml", () => {
  // Fails if production links can point at a local address, sign-up is confirmed without a link, or a secret or the SMTP block is versioned.
  it("has production values and no secret", () => {
    expect(settings).toMatch(/site_url = "https:\/\/retrofit\.thecreativetoken\.com"/);
    expect(settings).toMatch(/enable_confirmations = true/);
    expect(settings).not.toMatch(/127\.0\.0\.1|localhost|http:\/\//);
    expect(settings).not.toMatch(/smtp|pass|secret|AKIA|env\(/i);
    expect(settings).toContain(`project_id = "${PROJECT}"`);
  });

  // SE-M1, DO-M3. Fails if a few networks can use up the project's email or link-check limit within Retrofit's own limits.
  it("sets project limits well above one network's", () => {
    expect(Number(/email_sent = (\d+)/.exec(settings)?.[1])).toBeGreaterThanOrEqual(300);
    expect(Number(/token_verifications = (\d+)/.exec(settings)?.[1])).toBeGreaterThanOrEqual(300);
  });

  // Fails if the local file loses its warning, or is made to look like production.
  it("the local file says that it must not be pushed", () => {
    expect(read("supabase/config.toml")).toMatch(/Never run `supabase config push` with this file/);
    expect(read("supabase/config.toml")).toMatch(/site_url = "http:\/\/127\.0\.0\.1:3009"/);
  });
});

describe("tools/ops/production-auth.mjs", () => {
  // Fails if showing the difference can change production.
  it("shows the difference by default", () => {
    const { code, out } = run();
    expect([code, out]).toEqual([0, expect.stringContaining("diff")]);
    const args = spawnSync.mock.calls[0]![1] as string[];
    expect(args.slice(0, 3)).toEqual(["config", "diff", `--remote=${PROJECT}`]);
    expect(args).not.toContain("--yes");
  });

  // Fails if --apply alone, or with another project, changes production.
  it.each([[["--apply"]], [["--apply", "--project=other"]], [["--force"]]])("refuses %j without calling the CLI", (argv) => {
    expect(run(...argv).code).toBe(2);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  // Fails if the push does not use the versioned copy, or its failure is hidden.
  it("pushes a copy of the versioned file only with the project named", () => {
    let copied = "";
    spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      copied = fs.readFileSync(path.join(args.at(-1)!, "supabase/config.toml"), "utf8");
      return { status: 3, stdout: "", stderr: "refused" };
    });
    const { code, out } = run("--apply", `--project=${PROJECT}`);
    expect([code, out]).toEqual([3, expect.stringContaining("refused")]);
    expect(copied).toBe(read("supabase/production-auth.toml"));
    expect(spawnSync.mock.calls[0]![1]).toEqual(expect.arrayContaining(["push", "--yes"]));
  });
});
