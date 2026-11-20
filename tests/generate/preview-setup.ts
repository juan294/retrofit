import { handleAnalyze } from "@/lib/api/analyze";
import { bakery } from "../fixtures/sites";
import { serveSites } from "../helpers/sites";
import { analyzeRequest, cookieFrom, fakeClock, PUBLIC_ORIGIN, testDeps, type FakeClock, type TestDeps } from "../helpers/server-deps";

export interface ReadyPreview {
  readonly d: TestDeps;
  readonly fc: FakeClock;
  readonly id: string;
  readonly cookie: string;
  close(): Promise<void>;
}

/** Analyzes the bakery fixture through POST /api/analyze and waits until the analysis is ready. */
export async function readyBakeryPreview(): Promise<ReadyPreview> {
  const server = await serveSites(() => ({ "bakery.fixture.test": bakery }));
  const fc = fakeClock(Date.parse("2026-11-15T10:20:00.000Z"));
  const d = testDeps({ clock: fc.clock });
  const res = await handleAnalyze(analyzeRequest({ url: server.origin("bakery.fixture.test") }), d);
  const cookie = cookieFrom(res);
  const { id } = (await res.json()) as { id: string };
  await d.settle();
  return { d, fc, id, cookie, close: () => server.close() };
}

/** GET /p/<id>/<segments...> with an optional Cookie header. */
export function previewRequest(id: string, segments: readonly string[], cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${PUBLIC_ORIGIN}/p/${id}/${segments.map(encodeURIComponent).join("/")}`, { headers });
}
