import { describe, expect, it } from "vitest";
import { PROVIDERS, type Provider } from "@/lib/keys/providers";
import { testKey, type KeyTestResult } from "@/lib/keys/test-key";

const KEY = "gsk_SECRET_test_key_0123456789";
const byName = (name: string): Provider => PROVIDERS.find((p) => p.name === name)!;

type Call = { url: string; init: RequestInit | undefined };

/** The provider's HTTP endpoint is the boundary: a recorder answers in its place. */
function stubFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init };
    calls.push(call);
    return answer(call);
  };
  return { calls, fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function messageOf(result: KeyTestResult): string {
  return result.ok ? "" : result.message;
}

describe("testKey", () => {
  // Fails when the request leaves the provider's /models path, drops the Bearer header, puts the
  // key in the URL, sends cookies or follows redirects.
  it("sends GET <router>/models with the key only in the Authorization header", async () => {
    const stub = stubFetch(() => json({ data: [{ id: "openai/gpt-oss-120b" }] }));
    const result = await testKey({ provider: byName("Groq"), key: `  ${KEY}\n`, fetch: stub.fetch });
    expect(result).toEqual({ ok: true, models: ["openai/gpt-oss-120b"] });
    expect(stub.calls).toHaveLength(1);
    const [call] = stub.calls;
    expect(call!.url).toBe("https://api.groq.com/openai/v1/models");
    expect(call!.url).not.toContain(KEY);
    expect(call!.init?.method).toBe("GET");
    expect(new Headers(call!.init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call!.init?.credentials).toBe("omit");
    expect(call!.init?.redirect).toBe("error");
    expect(call!.init?.cache).toBe("no-store");
  });

  // Fails when a 401 or 403 is reported as anything other than a rejected key with the key page.
  it.each([401, 403])("turns HTTP %i into the provider's key message", async (status) => {
    const stub = stubFetch(() => json({ error: { message: `bad key ${KEY}` } }, status));
    const result = await testKey({ provider: byName("Groq"), key: KEY, fetch: stub.fetch });
    expect(result).toEqual({
      ok: false,
      kind: "unauthorized",
      message: "Groq did not accept this key. Check it at https://console.groq.com/keys.",
    });
  });

  // Fails when a fetch TypeError (CORS refusal or no connection) is not reported as the browser case.
  it("turns a fetch TypeError into the CORS message", async () => {
    const stub = stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const result = await testKey({ provider: byName("Google AI Studio"), key: KEY, fetch: stub.fetch });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.kind).toBe("cors");
    expect(messageOf(result)).toMatch(/^Google AI Studio did not answer from the browser\. /);
  });

  // Fails when another thrown error (timeout) is reported as a CORS block.
  it("turns an abort into the network message", async () => {
    const stub = stubFetch(() => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const result = await testKey({ provider: byName("Groq"), key: KEY, fetch: stub.fetch });
    expect(result.ok ? null : result.kind).toBe("network");
    expect(messageOf(result)).toMatch(/^Groq did not answer in time\./);
  });

  // Fails when a non-empty model list without the chosen model is accepted.
  it("reports a model the provider does not list", async () => {
    const stub = stubFetch(() => json({ data: [{ id: "llama-3.3-70b" }, { id: "qwen" }] }));
    const result = await testKey({ provider: byName("Groq"), model: "not-a-model", key: KEY, fetch: stub.fetch });
    expect(result).toEqual({
      ok: false,
      kind: "model-missing",
      message: "Groq does not list the model not-a-model. Choose another model under Advanced.",
    });
  });

  // Fails when Google's "models/<id>" form or an empty list blocks a valid key (runtime lets both pass).
  it("accepts a models/ prefixed id and an empty list", async () => {
    const google = stubFetch(() => json({ data: [{ id: "models/gemini-3.8-flash" }] }));
    expect((await testKey({ provider: byName("Google AI Studio"), key: KEY, fetch: google.fetch })).ok).toBe(true);
    const empty = stubFetch(() => json({ data: [] }));
    expect(await testKey({ provider: byName("Groq"), key: KEY, fetch: empty.fetch })).toEqual({ ok: true, models: [] });
  });

  // Fails when other HTTP errors are reported as success or as a key problem.
  it("reports other HTTP errors with the status", async () => {
    const stub = stubFetch(() => new Response("upstream down", { status: 503 }));
    const result = await testKey({ provider: byName("OpenAI"), key: KEY, fetch: stub.fetch });
    expect(result.ok ? null : result.kind).toBe("http");
    expect(messageOf(result)).toBe(
      "OpenAI answered with an error (HTTP 503). Try again later, or check your key at https://platform.openai.com/api-keys.",
    );
  });

  // Fails when OpenRouter's per-token prices are not converted to per million tokens for the model.
  it("reads OpenRouter prices per million tokens for the chosen model", async () => {
    const openrouter = byName("OpenRouter");
    const stub = stubFetch(() =>
      json({
        data: [
          { id: "other/model", pricing: { prompt: "0.00001", completion: "0.00002" } },
          { id: openrouter.model, pricing: { prompt: "0.00000015", completion: "0.0000006" } },
        ],
      }),
    );
    const result = await testKey({ provider: openrouter, key: "sk-or-v1-abc", fetch: stub.fetch });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pricePerMillion?.input).toBeCloseTo(0.15, 10);
    expect(result.pricePerMillion?.output).toBeCloseTo(0.6, 10);
  });

  // Fails when a missing or malformed price is turned into a number.
  it("gives no price when the provider does not report one", async () => {
    const stub = stubFetch(() => json({ data: [{ id: "gpt-5.5", pricing: { prompt: "n/a" } }] }));
    const result = await testKey({ provider: byName("OpenAI"), key: KEY, fetch: stub.fetch });
    expect(result).toEqual({ ok: true, models: ["gpt-5.5"] });
  });

  // Fails when Anthropic gets a /models request (it needs x-api-key; the plan checks on first message).
  it("skips the request for Anthropic", async () => {
    const stub = stubFetch(() => json({}));
    const result = await testKey({ provider: byName("Anthropic"), key: "sk-ant-abc", fetch: stub.fetch });
    expect(result).toEqual({ ok: true, checkedOnFirstMessage: true });
    expect(stub.calls).toHaveLength(0);
  });

  // Fails when a router outside the provider table is accepted (Advanced is a closed list).
  it("resolves a known router and refuses an unknown one without a request", async () => {
    const stub = stubFetch(() => json({ data: [] }));
    expect((await testKey({ router: "https://api.groq.com/openai/v1", key: KEY, fetch: stub.fetch })).ok).toBe(true);
    const refused = await testKey({ router: "https://evil.example/v1", key: KEY, fetch: stub.fetch });
    expect(refused.ok ? null : refused.kind).toBe("http");
    expect(stub.calls).toHaveLength(1);
  });

  // Fails when a key with spaces or control characters is sent (Headers would throw a TypeError
  // that reads like a CORS failure).
  it("refuses a key with characters keys never contain, without a request", async () => {
    const stub = stubFetch(() => json({ data: [] }));
    const result = await testKey({ provider: byName("Groq"), key: "gsk_abc def", fetch: stub.fetch });
    expect(result.ok ? null : result.kind).toBe("unauthorized");
    expect(messageOf(result)).toContain("https://console.groq.com/keys");
    expect(stub.calls).toHaveLength(0);
  });

  // Fails when any message echoes the key or the provider's response body.
  it("never puts the key in a message", async () => {
    const answers: Array<() => Response> = [
      () => json({ error: KEY }, 401),
      () => new Response(KEY, { status: 500 }),
      () => json({ data: [{ id: KEY }] }),
      () => {
        throw new TypeError(`Failed to fetch ${KEY}`);
      },
      () => {
        throw new Error(KEY);
      },
    ];
    for (const provider of PROVIDERS) {
      for (const answer of answers) {
        const stub = stubFetch(answer);
        const result = await testKey({ provider, key: KEY, fetch: stub.fetch });
        expect(JSON.stringify(result)).not.toContain(KEY);
      }
      const bad = await testKey({ provider, key: `${KEY} x`, fetch: stubFetch(() => json({})).fetch });
      expect(JSON.stringify(bad)).not.toContain(KEY);
    }
  });
});
