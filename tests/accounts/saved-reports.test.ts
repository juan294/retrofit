import { afterEach, describe, expect, it } from "vitest";
import { getAnalysis, readAnalysisView, reportBody } from "@/lib/analysis/record";
import { handleAnalyze } from "@/lib/api/analyze";
import { handleSaveReport } from "@/lib/api/saved-reports";
import { MAX_SAVED_REPORTS } from "@/lib/accounts/data";
import { SAVE_REPORT_TEXT } from "@/lib/site/account-texts";
import { readyBakeryPreview, type ReadyPreview } from "../generate/preview-setup";
import { accountCookie, analyzeRequest, holdAllSlots, postRequest, TEST_ACCOUNT as OWNER, testDeps } from "../helpers/server-deps";

let preview: ReadyPreview | undefined;
afterEach(async () => {
  await preview?.close();
  preview = undefined;
});

const save = (analysisId: unknown, cookie: string, o: { cross?: boolean } = {}) =>
  postRequest("/api/account/reports", { analysisId }, { cookie, ...(o.cross ? { fetchSite: "cross-site", origin: "https://evil.example" } : {}) });

describe("POST /api/account/reports (Save this report)", () => {
  // Fails if the saved copy differs from the report the results page shows, or is not listed for the account.
  it("saves the ready report of the visitor's analysis to the signed-in account", async () => {
    preview = await readyBakeryPreview();
    const { d, id, cookie } = preview;
    const session = await accountCookie(d);
    const res = await handleSaveReport(save(id, `${cookie}; ${session}`), d);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; message: string; href: string };
    expect(body.message).toBe(SAVE_REPORT_TEXT.saved);
    expect(body.href).toBe(`/account/reports/${body.id}`);

    const { analysis } = await readAnalysisView(d, (await getAnalysis(d.store, id))!);
    const expected = reportBody(analysis.score, analysis.readyAt!, d.config);
    const stored = await d.accounts.getSavedReport(OWNER.userId, body.id);
    expect(stored?.report).toEqual(expected);
    expect(stored?.host).toBe((expected as { host: string }).host);
    expect(stored?.fetchedAt).toBe(new Date((expected as { fetchedAt: string }).fetchedAt).toISOString());
    expect((await d.accounts.listSavedReports(OWNER.userId)).map((r) => r.id)).toEqual([body.id]);
  });

  // Fails if saving works signed out, for another visitor's analysis, before the report is ready, or from another site.
  it("refuses a signed-out visitor, another visitor's analysis, an unready analysis and a cross-site post", async () => {
    preview = await readyBakeryPreview();
    const { d, id, cookie } = preview;
    const session = await accountCookie(d);

    const signedOut = await handleSaveReport(save(id, cookie), d);
    expect(signedOut.status).toBe(401);
    expect(await signedOut.json()).toEqual({ error: "signed_out", message: SAVE_REPORT_TEXT.signedOut });

    const other = await handleSaveReport(save(id, `retrofit_visitor=${"b".repeat(32)}; ${session}`), d);
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: "not_found", message: SAVE_REPORT_TEXT.notFound });
    expect((await handleSaveReport(save("not-an-id", `${cookie}; ${session}`), d)).status).toBe(404);

    expect((await handleSaveReport(save(id, `${cookie}; ${session}`, { cross: true }), d)).status).toBe(403);
    expect(await d.accounts.listSavedReports(OWNER.userId)).toEqual([]);
  });

  // Fails if a queued analysis (no report yet) is saved as an empty report.
  it("answers 409 not_ready for an analysis that has no report yet", async () => {
    const d = testDeps();
    await holdAllSlots(d);
    const visitor = `retrofit_visitor=${"c".repeat(32)}`;
    const { id } = (await (await handleAnalyze(analyzeRequest({ url: "https://bakery.example.com" }, { cookie: visitor }), d)).json()) as { id: string };
    const session = await accountCookie(d);
    const res = await handleSaveReport(save(id, `${visitor}; ${session}`), d);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_ready", message: SAVE_REPORT_TEXT.notReady });
  });
});

describe("saving twice and the saved report limit (P2-R5)", () => {
  // Fails if a second click stores a second copy, or answers differently from the first beyond the "already saved" text.
  it("a second save of the same report answers 200 with the first id and the already-saved text", async () => {
    preview = await readyBakeryPreview();
    const { d, id, cookie } = preview;
    const session = await accountCookie(d);
    const first = (await (await handleSaveReport(save(id, `${cookie}; ${session}`), d)).json()) as { id: string };
    const second = await handleSaveReport(save(id, `${cookie}; ${session}`), d);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ id: first.id, message: SAVE_REPORT_TEXT.alreadySaved, href: `/account/reports/${first.id}` });
    expect(await d.accounts.listSavedReports(OWNER.userId)).toHaveLength(1);
  });

  // Fails if a full account silently drops the save, or the visitor is not told what to do.
  it("answers 409 full with the limit text when the account already keeps the most reports", async () => {
    preview = await readyBakeryPreview();
    const { d, id, cookie } = preview;
    for (let n = 0; n < MAX_SAVED_REPORTS; n++) {
      await d.accounts.saveReport(OWNER.userId, { host: "other.example", report: { score: n }, fetchedAt: new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString() });
    }
    const session = await accountCookie(d);
    const res = await handleSaveReport(save(id, `${cookie}; ${session}`), d);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "full", message: SAVE_REPORT_TEXT.full });
    expect(SAVE_REPORT_TEXT.full).toContain(String(MAX_SAVED_REPORTS));
    expect(await d.accounts.listSavedReports(OWNER.userId)).toHaveLength(MAX_SAVED_REPORTS);
  });
});
