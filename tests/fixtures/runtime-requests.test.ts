import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = "tests/fixtures/runtime-requests";

describe("captured runtime requests", () => {
  // Fails when the vendored runtime changes without a new capture (e2e/runtime-requests.spec.ts).
  it("were captured from the current vendored runtime", () => {
    expect(existsSync(DIR)).toBe(true);
    const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    const current = createHash("sha256").update(readFileSync("vendor/agentic-web.json")).digest("hex");
    for (const f of files) {
      const capture = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")) as { vendorManifestSha256: string; bodies: unknown[] };
      expect(capture.vendorManifestSha256, f).toBe(current);
      expect(capture.bodies.length, f).toBeGreaterThan(0);
    }
  });
});
