import { describe, expect, it } from "vitest";
import { BLOCKED_TEXT, RETIRED_TEXT, createFetchGuard } from "@/lib/preview/fetch-guard";
import { closePreviewAccess } from "@/lib/preview/page-guard";

describe("closePreviewAccess", () => {
  // Fails if unmounting a preview leaves the router, a peer or a provider reachable for a runtime
  // that is still running (the vendored runtime cannot be stopped).
  it("blocks every cross-origin destination and removes the runtime handle", async () => {
    const seen: string[] = [];
    const guard = createFetchGuard({
      pageOrigin: "https://retrofit.example",
      originalFetch: (async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return new Response("{}");
      }) as typeof fetch,
    });
    guard.setRouter("https://api.provider.example/v1");
    guard.setPolicyPeers(["https://peer.example"]);
    guard.approveFromConsent("peer.example");
    guard.authorizeProvider("https://api.other.example/v1");
    const w: { __nsweb?: unknown } = { __nsweb: { engine: { byokKey: "k" } } };
    closePreviewAccess(guard, w);
    await expect(guard.fetch("https://api.provider.example/v1/chat/completions", { method: "POST" })).rejects.toThrow(BLOCKED_TEXT("https://api.provider.example"));
    await expect(guard.fetch("https://peer.example/agent-manifest.json")).rejects.toThrow(BLOCKED_TEXT("https://peer.example"));
    await expect(guard.fetch("https://api.other.example/v1/models")).rejects.toThrow(BLOCKED_TEXT("https://api.other.example"));
    expect(seen).toEqual([]);
    expect(w.__nsweb).toBeUndefined();
  });

  // V08: fails if unmounting leaves the retired runtime's same-origin (free path) inference open.
  it("closes the retired runtime's same-origin inference", async () => {
    const seen: string[] = [];
    const guard = createFetchGuard({
      pageOrigin: "https://retrofit.example",
      originalFetch: (async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return new Response("{}");
      }) as typeof fetch,
    });
    const base = guard.setRouter("https://retrofit.example/api/inference/v1")!;
    closePreviewAccess(guard, {});
    await expect(guard.fetch(`${base}/chat/completions`, { method: "POST", body: "{}" })).rejects.toThrow(RETIRED_TEXT);
    expect(seen).toEqual([]);
  });
});
