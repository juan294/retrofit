const UNAVAILABLE = "Judge access is not available right now. Try again in a minute.";
const ON = "Judge access is on for this browser.";

export interface JudgeAnswer {
  readonly ok: boolean;
  readonly error: string | null;
  readonly message: string | null;
}

/**
 * The judge form's two requests: a free session, then the code for it. A session that is refused because
 * of the signed-in account's plan (or because the plan could not be read) does not stop a judge: the code's
 * own route opens the session with a valid code. Every other refusal is shown.
 */
export async function turnOnJudge(post: (path: string, body?: unknown) => Promise<JudgeAnswer>, code: string): Promise<{ readonly ok: boolean; readonly text: string }> {
  const session = await post("/api/inference/session");
  if (!session.ok && session.error !== "plan_required" && session.error !== "unavailable") return { ok: false, text: session.message ?? UNAVAILABLE };
  const judge = await post("/api/inference/session/judge", { code });
  return judge.ok ? { ok: true, text: ON } : { ok: false, text: judge.message ?? UNAVAILABLE };
}

export const JUDGE_UNAVAILABLE = UNAVAILABLE;
