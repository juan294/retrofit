import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

// UX-H2. Judges of an open-source challenge open the repository first.
describe("README.md", () => {
  // Fails if the README says again that there is no product, or gives no way to use it, judge it or run it.
  it("describes the product, with the live address, the judge page, the score API and the commands", () => {
    expect(readme).not.toMatch(/no application code|workspace setup only/i);
    for (const s of ["https://retrofit.thecreativetoken.com", "/judges", "/api/score", "agent-manifest.json", "pnpm dev", "rpi-verify.py", "Apache-2.0", "NOTICE"]) expect(readme, s).toContain(s);
  });

  // Fails if a relative link names a file that does not exist, a command is no script, or a secret form is in the text.
  it("links to files that exist, names real scripts, and holds no code or key", () => {
    for (const [, file] of readme.matchAll(/\]\((?!https?:)([^)#]+)\)/g)) expect(fs.existsSync(path.join(ROOT, file!)), file).toBe(true);
    const scripts = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts);
    for (const [, script] of readme.matchAll(/pnpm (dev|typecheck|lint|test(?::\w+)?|build)\b/g)) expect(scripts).toContain(script);
    expect(readme).not.toMatch(/sk_(test|live)_|rk_retrofit_[0-9a-f]|judge code is|JUDGE_CODE=/i);
  });
});
