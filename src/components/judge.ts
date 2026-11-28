const UNAVAILABLE = "Judge access is not available right now. Try again in a minute.";
const ON = "Judge access is on for this browser.";

export interface JudgeAnswer {
  readonly ok: boolean;
  readonly pool: string | null;
  readonly message: string | null;
}

/** The judge form's request: the code opens the judge session itself, without a free session first. A refusal is shown. */
export async function turnOnJudge(post: (path: string, body: unknown) => Promise<JudgeAnswer>, code: string): Promise<{ readonly ok: boolean; readonly text: string }> {
  const judge = await post("/api/inference/session/judge", { code });
  return judge.ok && judge.pool === "judge" ? { ok: true, text: ON } : { ok: false, text: judge.message ?? UNAVAILABLE };
}

export const JUDGE_UNAVAILABLE = UNAVAILABLE;
