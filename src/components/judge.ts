const UNAVAILABLE = "Judge access is not available right now. Try again in a minute.";
const ON = "Judge access is on for this browser.";

export interface JudgeAnswer {
  readonly ok: boolean;
  readonly error: string | null;
  readonly message: string | null;
}

/** The judge form's two requests: a free session, then the code for it. A refusal is shown. */
export async function turnOnJudge(post: (path: string, body?: unknown) => Promise<JudgeAnswer>, code: string): Promise<{ readonly ok: boolean; readonly text: string }> {
  const session = await post("/api/inference/session");
  if (!session.ok) return { ok: false, text: session.message ?? UNAVAILABLE };
  const judge = await post("/api/inference/session/judge", { code });
  return judge.ok ? { ok: true, text: ON } : { ok: false, text: judge.message ?? UNAVAILABLE };
}

export const JUDGE_UNAVAILABLE = UNAVAILABLE;
