import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { VERCEL_ENV } from "./helpers/vercel-env";

const secret = "s".repeat(32);
const vercel = VERCEL_ENV;

describe("free inference configuration", () => {
  // Fails if a Phase 6 default in the plan's table changes.
  it("applies the plan's defaults", () => {
    const f = loadConfig({ SESSION_SECRET: secret }).free;
    expect(f).toMatchObject({
      model: "alibaba/qwen3.8-flash",
      maxTokens: 1024,
      maxBodyBytes: 98304,
      framingTokensPerMessage: 16,
      framingTokensBase: 512,
      maxMessages: 80,
      maxTools: 16,
      maxToolBytes: 4096,
      inflightPerSession: 2,
      inflightGlobal: 16,
      callsPerSession: 40,
      sessionsPerClientHour: 6,
      judgeCallsPerSessionDay: 200,
      judgeSessionsPerClientDay: 20,
      upstreamTimeoutMs: 45000,
      alertThresholds: [0.5, 0.8, 0.95],
      upstreamUrl: "https://api.otari.ai/api/v1",
      perRequestFeeUsd: 0,
      keyPublic: null,
    });
    expect(f.serviceEndMs).toBe(Date.parse("2027-01-18T23:59:59Z"));
  });

  // Fails if Vercel can start without the owner's amounts, keys and secrets.
  it.each(["FREE_PRICE_IN_PER_M", "FREE_PRICE_OUT_PER_M", "FREE_CREDIT_USD", "JUDGE_RESERVE_USD", "OTARI_API_KEY", "JUDGE_CODE", "CRON_SECRET", "ALERT_GITHUB_TOKEN"])("requires %s on Vercel", (name) => {
    const env: Record<string, string> = { ...vercel };
    delete env[name];
    expect(() => loadConfig(env)).toThrow(new RegExp(name));
  });

  it("accepts a complete Vercel configuration and uses one key for both pools", () => {
    const f = loadConfig(vercel).free;
    expect(f.keyPublic).toBe("otk_server_test");
    expect(f.keyJudge).toBe("otk_server_test");
  });

  it("uses a key per pool when both are given", () => {
    const env: Record<string, string> = { ...vercel, OTARI_API_KEY_PUBLIC: "otk_pub", OTARI_API_KEY_JUDGE: "otk_judge" };
    delete env.OTARI_API_KEY;
    const f = loadConfig(env).free;
    expect([f.keyPublic, f.keyJudge]).toEqual(["otk_pub", "otk_judge"]);
  });

  // Fails if the reserve could equal or exceed the credit, or thresholds are unordered.
  it("refuses a reserve not below the credit and unordered thresholds", () => {
    expect(() => loadConfig({ SESSION_SECRET: secret, FREE_CREDIT_USD: "5", JUDGE_RESERVE_USD: "5" })).toThrow(/JUDGE_RESERVE_USD/);
    expect(() => loadConfig({ SESSION_SECRET: secret, CREDIT_ALERT_THRESHOLDS: "0.8,0.5" })).toThrow(/CREDIT_ALERT_THRESHOLDS/);
    expect(() => loadConfig({ SESSION_SECRET: secret, CREDIT_ALERT_THRESHOLDS: "0.5,1" })).toThrow(/CREDIT_ALERT_THRESHOLDS/);
  });

  // Fails if production could be pointed at another upstream.
  it("allows FREE_UPSTREAM_URL off Vercel only, and caps the upstream timeout", () => {
    expect(loadConfig({ SESSION_SECRET: secret, FREE_UPSTREAM_URL: "http://127.0.0.1:3013/otari/" }).free.upstreamUrl).toBe("http://127.0.0.1:3013/otari");
    expect(() => loadConfig({ ...vercel, FREE_UPSTREAM_URL: "https://evil.example" })).toThrow(/FREE_UPSTREAM_URL/);
    expect(() => loadConfig({ SESSION_SECRET: secret, FREE_UPSTREAM_TIMEOUT_MS: "55000" })).toThrow(/FREE_UPSTREAM_TIMEOUT_MS/);
  });

  // Fails if production can reach only Otari's US host: EU accounts get HTTP 421 there.
  it("selects Otari's regional host with OTARI_REGION, required on Vercel", () => {
    expect(loadConfig({ ...vercel, OTARI_REGION: "eu" }).free.upstreamUrl).toBe("https://eu.api.otari.ai/api/v1");
    expect(loadConfig({ ...vercel, OTARI_REGION: "us" }).free.upstreamUrl).toBe("https://api.otari.ai/api/v1");
    expect(loadConfig({ SESSION_SECRET: secret, OTARI_REGION: "eu" }).free.upstreamUrl).toBe("https://eu.api.otari.ai/api/v1");
    expect(() => loadConfig({ ...vercel, OTARI_REGION: "https://evil.example" })).toThrow(/OTARI_REGION/);
    const env: Record<string, string> = { ...vercel };
    delete env.OTARI_REGION;
    expect(() => loadConfig(env)).toThrow(/OTARI_REGION/);
  });

  it("accepts a per-request fee of zero or more", () => {
    expect(loadConfig({ SESSION_SECRET: secret, FREE_PER_REQUEST_FEE_USD: "0.0001" }).free.perRequestFeeUsd).toBe(0.0001);
    expect(() => loadConfig({ SESSION_SECRET: secret, FREE_PER_REQUEST_FEE_USD: "-1" })).toThrow(/FREE_PER_REQUEST_FEE_USD/);
  });

  // Fails if a short, guessable judge code is accepted in production.
  it("requires a judge code of at least 16 characters on Vercel", () => {
    expect(() => loadConfig({ ...VERCEL_ENV, JUDGE_CODE: "short-code" })).toThrow(/JUDGE_CODE/);
  });
});
