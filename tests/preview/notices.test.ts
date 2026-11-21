import { describe, expect, it } from "vitest";
import { noticeForTrace } from "@/lib/preview/notices";

describe("noticeForTrace", () => {
  // Fails if the loop notice text from phase-4.md changes or is dropped.
  it("turns composition_skip into the loop notice", () => {
    expect(noticeForTrace({ phase: "note", kind: "composition_skip", target: "http://caller-e2e.fixture.test:3010/retrofit_guide_e2e", reason: "already visited in this request" })).toEqual({
      kind: "loop",
      text: "Retrofit skipped a call back to http://caller-e2e.fixture.test:3010/retrofit_guide_e2e to prevent a loop.",
    });
  });

  // Fails if over-budget turns stay invisible (the runtime only returns a tool text).
  it("turns composition_limit into a visible limit notice", () => {
    const n = noticeForTrace({ phase: "note", kind: "composition_limit", target: "http://peer-a.fixture.test:3011/peer_demo", reason: "remote call budget exhausted" });
    expect(n?.kind).toBe("limit");
    expect(n?.text).toContain("limit");
    expect(n?.text).toContain("remote call budget exhausted");
  });

  // Fails if a failed peer network load (invalid network) is not shown.
  it("turns a failed remote_fetch into a visible error", () => {
    const n = noticeForTrace({ phase: "end", kind: "remote_fetch", status: "error", peerOrigin: "peer-a.fixture.test:3011", error: "Network 'peer_demo' failed validation: x" });
    expect(n).toEqual({ kind: "error", text: "Retrofit could not load the network from peer-a.fixture.test:3011: Network 'peer_demo' failed validation: x" });
  });

  // Fails if a policy refusal (denied origin) or a guard block surfaces only inside the model's tool result.
  it("turns a policy refusal and a guard block on a tool into visible errors", () => {
    const policy = noticeForTrace({ phase: "end", kind: "tool", status: "error", tool: "peer_demo", error: "Policy: peer-a.fixture.test:3011 is not in retrofit_guide_denied's allowed_peers; refusing to contact it." });
    expect(policy?.kind).toBe("denied");
    expect(policy?.text).toBe("Retrofit refused to contact peer-a.fixture.test:3011 because this agent does not allow it.");
    const blocked = noticeForTrace({ phase: "end", kind: "tool", status: "error", tool: "peer_demo", error: "Retrofit blocked a request to http://third.fixture.test:3013 that was not approved." });
    expect(blocked).toEqual({ kind: "blocked", text: "Retrofit blocked a request to http://third.fixture.test:3013 that was not approved." });
  });

  it("ignores ordinary events", () => {
    expect(noticeForTrace({ phase: "end", kind: "tool", status: "ok", tool: "website_search_site_content" })).toBeNull();
    expect(noticeForTrace({ phase: "start", kind: "remote_fetch" })).toBeNull();
    expect(noticeForTrace(null)).toBeNull();
  });
});

describe("free-path notices", () => {
  // Fails if a free-path cap reached in a model call does not become a visible notice for the banner.
  it("turns a free cap in a failed model call into a free notice", () => {
    const text = "Retrofit's free AI is used up for this session. Use your own AI key to continue.";
    expect(noticeForTrace({ phase: "end", kind: "model_call", status: "error", error: `LLM HTTP 429: {"error":{"message":"${text}"}}` })).toEqual({ kind: "free", text });
    expect(noticeForTrace({ phase: "end", kind: "model_call", status: "error", error: "LLM HTTP 502: The free AI provider did not answer. Try again, or use your own key." })?.kind).toBe("free");
    expect(noticeForTrace({ phase: "end", kind: "model_call", status: "error", error: "LLM HTTP 401: invalid key" })).toBeNull();
  });
});
