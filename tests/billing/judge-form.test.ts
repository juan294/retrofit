import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JudgeForm } from "@/components/JudgeForm";
import { KeyPanel } from "@/components/key-panel/KeyPanel";
import { turnOnJudge, type JudgeAnswer } from "@/components/judge";

const answer = (a: Partial<JudgeAnswer>): JudgeAnswer => ({ ok: false, pool: null, message: null, ...a });

/** Runs the form's request against a fixed answer; returns the text and what it asked. */
async function run(judge: JudgeAnswer) {
  const asked: unknown[] = [];
  const result = await turnOnJudge(async (path, body) => {
    asked.push([path, body]);
    return judge;
  }, "the-code");
  return { ...result, asked };
}
const ASKED = [["/api/inference/session/judge", { code: "the-code" }]];

describe("the judge form", () => {
  // UX-H3. Fails if the form asks for a public session first (its hourly count would refuse a judge before the code is read).
  it("sends only the code", async () => {
    expect(await run(answer({ ok: true, pool: "judge" }))).toEqual({ ok: true, text: "Judge access is on for this browser.", asked: ASKED });
  });

  // Fails if a refusal is hidden, or access is called on when the answer's pool is not the judges'.
  it("shows every refusal", async () => {
    expect(await run(answer({ message: "That judge code is not valid." }))).toMatchObject({ ok: false, text: "That judge code is not valid." });
    const unavailable = { ok: false, text: "Judge access is not available right now. Try again in a minute." };
    expect(await run(answer({}))).toMatchObject(unavailable);
    expect(await run(answer({ ok: true, pool: "public" }))).toMatchObject(unavailable);
  });

  // FE-M1. Fails if a click or Enter before hydration can submit the form as GET (the judge code would land in the
  // page URL, history and logs): the form must post and its button must start disabled.
  it("posts and keeps its button disabled until the page is hydrated", () => {
    const html = renderToStaticMarkup(createElement(JudgeForm));
    expect(/<form[^>]*>/.exec(html)?.[0]).toMatch(/method="post"/);
    expect(/<button[^>]*type="submit"[^>]*>/.exec(html)?.[0]).toMatch(/disabled=""/);
  });
});

// UX-H3. Fails if the panel does not say that judge access is on, or says so in the public pool.
it("the key panel says when judge access is on", () => {
  const guard = { authorizeProvider() {}, revokeProvider() {} };
  const html = (judgeAccess: boolean) => renderToStaticMarkup(createElement(KeyPanel, { guard, onConnect() {}, onForget() {}, freePathActive: true, judgeAccess }));
  expect(html(true)).toContain("Judge access is on. Using Retrofit&#x27;s free AI");
  expect(html(false)).toContain("Using Retrofit&#x27;s free AI");
  expect(html(false)).not.toContain("Judge access");
});
