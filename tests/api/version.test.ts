import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCommit } from "@/lib/api/version";

describe("build commit", () => {
  // Fails if /api/version stops preferring the explicit build commit.
  it("prefers BUILD_COMMIT, then Vercel's Git commit, else unknown", () => {
    expect(buildCommit({ BUILD_COMMIT: "abc", VERCEL_GIT_COMMIT_SHA: "def" })).toBe("abc");
    expect(buildCommit({ VERCEL_GIT_COMMIT_SHA: "def" })).toBe("def");
    expect(buildCommit({})).toBe("unknown");
  });
});

describe("vercel.json", () => {
  const v = JSON.parse(readFileSync("vercel.json", "utf8"));
  // Fails if develop or sutura branches could deploy, or a non-production build is not skipped.
  it("deploys only production builds of main", () => {
    expect(v.git.deploymentEnabled).toEqual({ develop: false, "sutura/*": false });
    expect(v.ignoreCommand).toBe('test "$VERCEL_ENV" != "production"');
  });
  it("runs the cleanup and credit-check crons and gives API routes 60 s", () => {
    expect(v.crons.map((c: { path: string }) => c.path).sort()).toEqual(["/api/cron/cleanup", "/api/cron/credit-check"]);
    expect(v.functions["src/app/api/**/*.ts"].maxDuration).toBe(60);
  });
});
