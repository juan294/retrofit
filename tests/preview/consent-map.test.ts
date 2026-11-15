import { describe, expect, it } from "vitest";
import { createFetchGuard } from "@/lib/preview/fetch-guard";

const PAGE = "http://127.0.0.1:3010";

function guardWith(peers: string[]) {
  const logs: string[] = [];
  const guard = createFetchGuard({
    pageOrigin: PAGE,
    originalFetch: async () => new Response("unused"),
    log: (message) => logs.push(message),
  });
  guard.setPolicyPeers(peers);
  return { guard, logs };
}

describe("approveFromConsent maps the runtime's host:port to one configured origin", () => {
  // Fails if the mapping compares against the full origin (with scheme) instead of URL.host,
  // or if a match does not add the full origin to the approved peers.
  it("maps peer-a.fixture.test:3011 to http://peer-a.fixture.test:3011", () => {
    const { guard } = guardWith(["http://peer-a.fixture.test:3011", "http://peer-b.fixture.test:3011"]);
    expect(guard.approveFromConsent("peer-a.fixture.test:3011")).toBe("http://peer-a.fixture.test:3011");
    expect(guard.state().approvedPeers).toEqual(["http://peer-a.fixture.test:3011"]);
  });

  // Fails if the mapping picks the first of several matches instead of refusing the ambiguity.
  it("approves nothing when the host matches both an http and an https origin", () => {
    const { guard, logs } = guardWith(["http://peer.example", "https://peer.example"]);
    expect(guard.approveFromConsent("peer.example")).toBeNull();
    expect(guard.state().approvedPeers).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("peer.example");
    expect(logs[0]).toContain("2");
  });

  // Fails if an unmatched host is approved anyway (for example by building an origin from it).
  it("approves nothing when no configured origin matches", () => {
    const { guard, logs } = guardWith(["http://peer-a.fixture.test:3011"]);
    expect(guard.approveFromConsent("third.fixture.test:3013")).toBeNull();
    expect(guard.state().approvedPeers).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("third.fixture.test:3013");
  });

  // Fails if the mapping compares hostnames only and ignores the port.
  it("does not match a different port", () => {
    const { guard } = guardWith(["http://peer-a.fixture.test:3011"]);
    expect(guard.approveFromConsent("peer-a.fixture.test:3012")).toBeNull();
    expect(guard.state().approvedPeers).toEqual([]);
  });

  // Fails if configured origins are not normalized with URL (default port kept, so the host
  // would be "peer.example:443" and never equal the runtime's URL.host "peer.example").
  it("maps a host without a port to the configured origin on the default port", () => {
    const { guard } = guardWith(["https://peer.example:443"]);
    expect(guard.approveFromConsent("peer.example")).toBe("https://peer.example");
    expect(guard.state().approvedPeers).toEqual(["https://peer.example"]);
  });

  // Fails if approval is allowed for an origin outside the policy (here only https is configured).
  it("maps peer.example to https://peer.example when only that is configured", () => {
    const { guard } = guardWith(["https://peer.example", "http://other.example"]);
    expect(guard.approveFromConsent("peer.example")).toBe("https://peer.example");
    expect(guard.state().approvedPeers).toEqual(["https://peer.example"]);
  });
});
