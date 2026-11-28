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
  it("runs the cleanup, credit-check and claims crons and gives API routes 60 s", () => {
    expect(v.crons.map((c: { path: string }) => c.path).sort()).toEqual(["/api/cron/claims", "/api/cron/cleanup", "/api/cron/credit-check"]);
    expect(v.functions["src/app/api/**/*.ts"].maxDuration).toBe(60);
  });
  // Phase 3. Fails if the claim recheck is not daily, or starts at the same minute as another cron.
  it("rechecks claims once a day at a minute no other cron uses", () => {
    const schedules = v.crons.map((c: { schedule: string }) => c.schedule);
    const claims = v.crons.find((c: { path: string }) => c.path === "/api/cron/claims")?.schedule as string;
    expect(claims).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    expect(new Set(schedules.map((s: string) => s.split(" ")[0])).size).toBe(schedules.length);
  });
});

describe("build commit inlining", () => {
  // Fails if version.ts reads BUILD_COMMIT through a variable env object, which Next.js does not inline
  // (the deployed /api/version would then report "unknown"). The e2e version case checks the built value.
  it("reads the literal process.env.BUILD_COMMIT token", () => {
    expect(readFileSync("src/lib/api/version.ts", "utf8")).toContain("process.env.BUILD_COMMIT;");
  });
});
