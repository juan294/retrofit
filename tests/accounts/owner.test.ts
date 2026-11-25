import { afterEach, describe, expect, it } from "vitest";
import { createAccountSession } from "@/lib/accounts/session";
import { attachVisitorAnalyses, findOwnedAnalysis } from "@/lib/analysis/owner";
import { analysisKey, getAnalysis, readAnalysisView, type Analysis } from "@/lib/analysis/record";
import { visitorTexts } from "@/lib/analysis/texts";
import { handleAnalyze } from "@/lib/api/analyze";
import { handleAnalysisStatus } from "@/lib/api/status";
import { handlePreviewFile } from "@/lib/preview/artifacts";
import { sha256Hex } from "@/lib/security/tokens";
import { previewRequest, readyBakeryPreview, type ReadyPreview } from "../generate/preview-setup";
import { ACCOUNT_COOKIE, accountCookie, analyzeRequest, holdAllSlots, OTHER_ACCOUNT as OTHER, statusRequest, storeDump, TEST_ACCOUNT as OWNER, testDeps } from "../helpers/server-deps";
const notFound = { error: "not_found", message: visitorTexts.otherBrowser };

let preview: ReadyPreview | undefined;
afterEach(async () => {
  await preview?.close();
  preview = undefined;
});

/** A ready preview whose analysis is attached to OWNER, and session cookies for OWNER and OTHER. */
async function attachedPreview() {
  preview = await readyBakeryPreview();
  const d = preview.d;
  await readAnalysisView(d, (await getAnalysis(d.store, preview.id))!);
  const visitorToken = preview.cookie.split("=")[1]!;
  expect(await attachVisitorAnalyses(d, sha256Hex(visitorToken), OWNER.userId)).toBe(1);
  const owner = await accountCookie(d, OWNER);
  const other = await accountCookie(d, OTHER);
  return { ...preview, owner, other };
}

describe("owner checks accept the visitor or the attached account", () => {
  // Fails if the status route refuses the attached account on another browser, or lets another account in.
  it("status: the attached account reads it without the visitor cookie; another account gets the 404 text", async () => {
    const { d, id, cookie, owner, other } = await attachedPreview();
    expect((await handleAnalysisStatus(statusRequest(id, { cookie: owner }), d, id)).status).toBe(200);
    expect((await handleAnalysisStatus(statusRequest(id, { cookie }), d, id)).status).toBe(200);
    const refused = await handleAnalysisStatus(statusRequest(id, { cookie: other }), d, id);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual(notFound);
    expect((await handleAnalysisStatus(statusRequest(id), d, id)).status).toBe(404);
  });

  // Fails if a preview file is served to another account, or refused to the attached account.
  it("preview files: the attached account gets them, another account gets the 404 text", async () => {
    const { d, id, owner, other } = await attachedPreview();
    const get = (cookie: string) => handlePreviewFile(previewRequest(id, ["agent-manifest.json"], cookie), d, id, ["agent-manifest.json"]);
    expect((await get(owner)).status).toBe(200);
    const refused = await get(other);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual(notFound);
  });

  // Fails if the shared owner lookup (results page, routes, saved reports) accepts another visitor or account.
  it("findOwnedAnalysis: visitor cookie or attached account yes; another visitor or account no", async () => {
    const d = testDeps();
    const id = "e".repeat(32);
    const stored: Analysis = { version: 1, id, ownerHash: sha256Hex("a".repeat(32)), accountId: OWNER.userId, jobId: "j", inputOrigin: "https://x.example", createdAt: 0, expiresAt: Date.now() + 3_600_000 };
    await d.store.set(analysisKey(id), stored, 3600);
    const owner = (await createAccountSession(d, OWNER)).token;
    const other = (await createAccountSession(d, OTHER)).token;
    const found = (visitorToken: string | null, accountToken: string | null) => findOwnedAnalysis(id, { visitorToken, accountToken }, d);
    expect((await found("a".repeat(32), null)).analysis?.id).toBe(id);
    expect((await found("b".repeat(32), owner)).analysis?.id).toBe(id);
    expect((await found("b".repeat(32), other)).analysis).toBeNull();
    expect((await found(null, null)).analysis).toBeNull();
    await d.store.set(analysisKey(id), { ...stored, accountId: undefined }, 3600);
    expect((await found(null, owner)).analysis).toBeNull();
  });

  // Fails if an analysis attached to one account moves to another at a later sign-in on the same browser.
  it("keeps the first account when the same browser later signs in to another", async () => {
    const { d, id, cookie } = await attachedPreview();
    expect(await attachVisitorAnalyses(d, sha256Hex(cookie.split("=")[1]!), OTHER.userId)).toBe(0);
    expect((await getAnalysis(d.store, id))?.accountId).toBe(OWNER.userId);
  });
});

describe("analyses started while signed in", () => {
  // Fails if a signed-in visitor's new analysis is not attached at creation, or is listed for attaching again.
  it("are attached at creation and not listed under the visitor", async () => {
    const d = testDeps();
    await holdAllSlots(d);
    const res = await handleAnalyze(analyzeRequest({ url: "https://bakery.example.com" }, { cookie: `retrofit_visitor=${"c".repeat(32)}; ${await accountCookie(d, OWNER)}` }), d);
    const { id } = (await res.json()) as { id: string };
    expect((await getAnalysis(d.store, id))?.accountId).toBe(OWNER.userId);
    expect(storeDump(d.backing)).not.toContain(`visitor-analyses:${sha256Hex("c".repeat(32))}`);
  });

  // Fails if an anonymous analysis is not listed under its visitor (sign-in could not attach it), or gets an account.
  it("anonymous analyses are listed under the visitor and have no account", async () => {
    const d = testDeps();
    await holdAllSlots(d);
    const res = await handleAnalyze(analyzeRequest({ url: "https://bakery.example.com" }, { cookie: `retrofit_visitor=${"c".repeat(32)}` }), d);
    const { id } = (await res.json()) as { id: string };
    expect((await getAnalysis(d.store, id))?.accountId).toBeUndefined();
    expect(storeDump(d.backing)).toContain(`visitor-analyses:${sha256Hex("c".repeat(32))}`);
  });
});

describe("one owner lookup (P2-R10)", () => {
  // Fails if a page or route reads the account session more than once, decides ownership wrongly, or reads anything without cookies.
  it("findOwnedAnalysis reads the session at most once and answers the analysis with the signed-in account", async () => {
    let sessionReads = 0;
    let reads = 0;
    const d = testDeps({ instrument: (op, key) => void (op === "get" && (reads++, key.startsWith("account-session:") && sessionReads++)) });
    await holdAllSlots(d);
    const visitor = "c".repeat(32);
    const token = (await createAccountSession(d, OWNER)).token;
    const { id } = (await (await handleAnalyze(analyzeRequest({ url: "https://bakery.example.com" }, { cookie: `retrofit_visitor=${visitor}; ${ACCOUNT_COOKIE}=${token}` }), d)).json()) as { id: string };
    const other = (await createAccountSession(d, OTHER)).token;
    sessionReads = 0;

    const byAccount = await findOwnedAnalysis(id, { visitorToken: null, accountToken: token }, d);
    expect(byAccount.analysis?.id).toBe(id);
    expect(byAccount.account?.accountId).toBe(OWNER.userId);
    expect(sessionReads).toBe(1);

    sessionReads = 0;
    expect((await findOwnedAnalysis(id, { visitorToken: visitor, accountToken: other }, d)).account?.accountId).toBe(OTHER.userId);
    expect(sessionReads).toBe(1);
    expect((await findOwnedAnalysis(id, { visitorToken: "d".repeat(32), accountToken: other }, d)).analysis).toBeNull();
    sessionReads = 0;
    expect(await findOwnedAnalysis(id, { visitorToken: visitor, accountToken: null }, d)).toMatchObject({ analysis: { id }, account: null });
    expect(sessionReads).toBe(0);
    reads = 0;
    expect(await findOwnedAnalysis("not-an-id", { visitorToken: visitor, accountToken: null }, d)).toEqual({ analysis: null, account: null });
    expect(await findOwnedAnalysis(id, { visitorToken: null, accountToken: null }, d)).toEqual({ analysis: null, account: null });
    expect(reads).toBe(0);
  });
});
