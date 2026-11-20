import { json } from "./json";

// Next.js inlines the literal `process.env.BUILD_COMMIT` at build time (next.config.ts `env`);
// `vercel deploy --build-env BUILD_COMMIT=<sha>` sets it for the build only, so it must be read this way.
const BUILT_COMMIT: string | undefined = process.env.BUILD_COMMIT;

/** The source commit this build was made from: BUILD_COMMIT at build time, else Vercel's Git commit, else "unknown". */
export function buildCommit(env: { BUILD_COMMIT?: string; VERCEL_GIT_COMMIT_SHA?: string } = { BUILD_COMMIT: BUILT_COMMIT, VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA }): string {
  return env.BUILD_COMMIT?.trim() || env.VERCEL_GIT_COMMIT_SHA?.trim() || "unknown";
}

export function handleVersion(): Response {
  return json(200, { commit: buildCommit() });
}
