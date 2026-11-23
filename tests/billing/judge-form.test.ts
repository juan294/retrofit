import { describe, expect, it } from "vitest";
import { turnOnJudge, type JudgeAnswer } from "@/components/judge";

const ok: JudgeAnswer = { ok: true, error: null, message: null };
const refused = (error: string, message: string): JudgeAnswer => ({ ok: false, error, message });

/** Runs the form's two requests against fixed answers; returns the text and the paths it asked. */
async function run(session: JudgeAnswer, judge: JudgeAnswer = ok) {
  const asked: string[] = [];
  const result = await turnOnJudge(async (path) => {
    asked.push(path);
    return path.endsWith("/judge") ? judge : session;
  }, "the-code");
  return { ...result, asked };
}
const BOTH = ["/api/inference/session", "/api/inference/session/judge"];

describe("the judge form", () => {
  // Fails if a plan refusal of the free session (a judge signed in to a Free account) stops before the code was tried.
  it("tries the code after a plan refusal or an unreadable plan", async () => {
    expect(await run(ok)).toEqual({ ok: true, text: "Judge access is on for this browser.", asked: BOTH });
    for (const s of [refused("plan_required", "needs a plan"), refused("unavailable", "not available")]) expect(await run(s)).toEqual({ ok: true, text: "Judge access is on for this browser.", asked: BOTH });
    expect(await run(refused("plan_required", "needs a plan"), refused("invalid_code", "That judge code is not valid."))).toMatchObject({ ok: false, text: "That judge code is not valid." });
  });

  // Fails if another refusal of the session (its hourly limit) is hidden by the code's answer, as it was not before.
  it("shows every other refusal of the session and does not try the code", async () => {
    expect(await run(refused("session_limit", "used up"))).toEqual({ ok: false, text: "used up", asked: BOTH.slice(0, 1) });
    expect(await run({ ok: false, error: null, message: null })).toMatchObject({ ok: false, text: "Judge access is not available right now. Try again in a minute." });
  });
});
