import { afterEach, describe, expect, it } from "vitest";
import { ACCOUNT_COOKIE, createAccountSession } from "@/lib/accounts/session";
import { attachVisitorAnalyses, ownsAnalysis, resultsPageAccess } from "@/lib/analysis/owner";
import { getAnalysis, readAnalysisView } from "@/lib/analysis/record";
import { visitorTexts } from "@/lib/analysis/texts";
import { handleAnalyze } from "@/lib/api/analyze";
import { handleAnalysisStatus } from "@/lib/api/status";
import { handlePreviewFile } from "@/lib/preview/artifacts";
import { sha256Hex } from "@/lib/security/tokens";
import { previewRequest, readyBakeryPreview, type ReadyPreview } from "../generate/preview-setup";
import { analyzeRequest, holdAllSlots, statusRequest, storeDump, testDeps } from "../helpers/server-deps";

const OWNER = { userId: "4f1c2b8e-1d2a-4e55-9c3b-2a1b0c9d8e7f", email: "owner@example.test" };
const OTHER = { userId: "5f1c2b8e-1d2a-4e55-9c3b-2a1b0c9d8e7f", email: "other@example.test" };
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
  const owner = `${ACCOUNT_COOKIE}=${(await createAccountSession(d, OWNER)).token}`;
  const other = `${ACCOUNT_COOKIE}=${(await createAccountSession(d, OTHER)).token}`;
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

  // Fails if the results page check (ownsAnalysis) disagrees with the routes.
  it("ownsAnalysis: visitor cookie or attached account yes; another visitor or account no", async () => {
    const d = testDeps();
    const a = { ownerHash: sha256Hex("a".repeat(32)), accountId: OWNER.userId };
    const owner = (await createAccountSession(d, OWNER)).token;
    const other = (await createAccountSession(d, OTHER)).token;
    expect(await ownsAnalysis(a, { visitorToken: "a".repeat(32), accountToken: null }, d)).toBe(true);
    expect(await ownsAnalysis(a, { visitorToken: "b".repeat(32), accountToken: owner }, d)).toBe(true);
    expect(await ownsAnalysis(a, { visitorToken: "b".repeat(32), accountToken: other }, d)).toBe(false);
    expect(await ownsAnalysis({ ownerHash: a.ownerHash }, { visitorToken: null, accountToken: owner }, d)).toBe(false);
    expect(await ownsAnalysis(a, { visitorToken: null, accountToken: null }, d)).toBe(false);
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
    const session = (await createAccountSession(d, OWNER)).token;
    const res = await handleAnalyze(analyzeRequest({ url: "https://bakery.example.com" }, { cookie: `retrofit_visitor=${"c".repeat(32)}; ${ACCOUNT_COOKIE}=${session}` }), d);
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

describe("results page access (P2-R10)", () => {
  // Fails if the results page reads the account session more than once, or decides ownership or "signed in" wrongly.
  it("reads the session once and answers the analysis with whether the visitor is signed in", async () => {
    let sessionReads = 0;
    const d = testDeps({ instrument: (op, key) => void (op === "get" && key.startsWith("account-session:") && sessionReads++) });
    await holdAllSlots(d);
    const visitor = "c".repeat(32);
    const token = (await createAccountSession(d, OWNER)).token;
    const { id } = (await (await handleAnalyze(analyzeRequest({ url: "https://bakery.example.com" }, { cookie: `retrofit_visitor=${visitor}; ${ACCOUNT_COOKIE}=${token}` }), d)).json()) as { id: string };
    const other = (await createAccountSession(d, OTHER)).token;
    sessionReads = 0;

    const byAccount = await resultsPageAccess(id, { visitorToken: null, accountToken: token }, d);
    expect(byAccount?.analysis.id).toBe(id);
    expect(byAccount?.signedIn).toBe(true);
    expect(sessionReads).toBe(1);

    sessionReads = 0;
    expect((await resultsPageAccess(id, { visitorToken: visitor, accountToken: other }, d))?.signedIn).toBe(true);
    expect(sessionReads).toBe(1);
    expect(await resultsPageAccess(id, { visitorToken: "d".repeat(32), accountToken: other }, d)).toBeNull();
    expect((await resultsPageAccess(id, { visitorToken: visitor, accountToken: null }, d))?.signedIn).toBe(false);
    expect(await resultsPageAccess("not-an-id", { visitorToken: visitor, accountToken: null }, d)).toBeNull();
  });
});
