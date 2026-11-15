import { json } from "./json";

/** The source commit this build was made from: BUILD_COMMIT at build time, else Vercel's Git commit, else "unknown". */
export function buildCommit(env: Record<string, string | undefined> = process.env): string {
  return env.BUILD_COMMIT?.trim() || env.VERCEL_GIT_COMMIT_SHA?.trim() || "unknown";
}

export function handleVersion(): Response {
  return json(200, { commit: buildCommit() });
}
