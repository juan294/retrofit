import { describe, expect, it } from "vitest";
import { connectKey, priceText } from "@/lib/keys/connect";

const KEY = "gsk_SECRET_connect_0123";

/** Records guard calls and fetches in one ordered log (the fetch is the provider boundary). */
function harness(answer: () => Response | Promise<Response>) {
  const log: string[] = [];
  const guard = {
    authorizeProvider: (router: string) => void log.push(`authorize ${router}`),
    revokeProvider: () => void log.push("revoke"),
  };
  const fetch = async (input: RequestInfo | URL) => {
    log.push(`fetch ${String(input)}`);
    return answer();
  };
  return { log, guard, fetch };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("connectKey", () => {
  // Fails when the provider is authorized after the request (the guard would refuse it), or when
  // a successful connect revokes it (the integration owner revokes after setRouter).
  it("authorizes the detected provider right before validation and keeps it on success", async () => {
    const h = harness(() => json({ data: [{ id: "openai/gpt-oss-120b" }] }));
    const result = await connectKey({ guard: h.guard, key: KEY, fetch: h.fetch });
    expect(h.log).toEqual(["authorize https://api.groq.com/openai/v1", "fetch https://api.groq.com/openai/v1/models"]);
    expect(result).toEqual({
      ok: true,
      connection: { provider: "Groq", router: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", key: KEY },
      price: "Cost depends on your provider.",
      note: null,
    });
  });

  // Fails when a failed validation leaves the provisional provider authorized.
  it("revokes the provider when validation fails and returns the provider message", async () => {
    const h = harness(() => json({}, 401));
    const result = await connectKey({ guard: h.guard, key: KEY, fetch: h.fetch });
    expect(h.log.at(-1)).toBe("revoke");
    expect(result).toEqual({ ok: false, message: "Groq did not accept this key. Check it at https://console.groq.com/keys." });
  });

  // Fails when an unrecognized key reaches the guard or the network.
  it("asks for a provider when the key is not recognized, without guard or network calls", async () => {
    const h = harness(() => json({}));
    const result = await connectKey({ guard: h.guard, key: "mystery-key", fetch: h.fetch });
    expect(h.log).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toMatch(/choose your provider under Advanced/);
    expect(result.ok ? "" : result.message).not.toContain("mystery-key");
  });

  // Fails when the Advanced router choice is ignored in favour of detection, or a free-text router
  // outside providers.ts is accepted.
  it("uses the Advanced router and model, and refuses a router outside the list", async () => {
    const h = harness(() => json({ data: [{ id: "x/model", pricing: { prompt: "0.000001", completion: "0.000002" } }] }));
    const result = await connectKey({
      guard: h.guard,
      key: "custom-openrouter-key",
      router: "https://openrouter.ai/api/v1",
      model: "x/model",
      fetch: h.fetch,
    });
    expect(h.log[0]).toBe("authorize https://openrouter.ai/api/v1");
    expect(result.ok && result.connection.model).toBe("x/model");
    expect(result.ok && result.price).toBe("About $1.00 per million input tokens and $2.00 per million output tokens.");

    const bad = harness(() => json({}));
    const refused = await connectKey({ guard: bad.guard, key: KEY, router: "https://evil.example/v1", fetch: bad.fetch });
    expect(refused.ok).toBe(false);
    expect(bad.log).toEqual([]);
  });

  // Fails when an empty paste is sent anywhere.
  it("asks for a key when the field is empty", async () => {
    const h = harness(() => json({}));
    expect(await connectKey({ guard: h.guard, key: "   ", fetch: h.fetch })).toEqual({ ok: false, message: "Paste your key first." });
    expect(h.log).toEqual([]);
  });

  // Fails when Anthropic's skipped check is presented as a verified key.
  it("tells the visitor that Anthropic is checked on the first message", async () => {
    const h = harness(() => json({}));
    const result = await connectKey({ guard: h.guard, key: "sk-ant-abc", fetch: h.fetch });
    expect(result.ok && result.note).toBe("Anthropic checks the key when you send your first message.");
  });
});

describe("priceText", () => {
  // Fails when sub-cent prices are rounded to $0.00 or the fallback text changes.
  it("formats per-million prices and falls back to the plain text", () => {
    expect(priceText({ input: 0.15, output: 0.6 })).toBe(
      "About $0.15 per million input tokens and $0.60 per million output tokens.",
    );
    expect(priceText({ input: 0.0042, output: 0 })).toBe(
      "About $0.0042 per million input tokens and $0.00 per million output tokens.",
    );
    expect(priceText(undefined)).toBe("Cost depends on your provider.");
  });
});
