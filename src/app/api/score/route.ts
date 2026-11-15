import { handleScore, handleScoreMethodNotAllowed, handleScoreOptions } from "@/lib/api/score";
import { getServerDeps } from "@/lib/server/runtime";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleScore(request, getServerDeps());
}

export function OPTIONS(): Response {
  return handleScoreOptions();
}

// The contract answers every other method with 405 and its JSON body.
export const HEAD = handleScoreMethodNotAllowed;
export const POST = handleScoreMethodNotAllowed;
export const PUT = handleScoreMethodNotAllowed;
export const PATCH = handleScoreMethodNotAllowed;
export const DELETE = handleScoreMethodNotAllowed;
