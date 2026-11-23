import { describe, expect, it } from "vitest";
import { AccountDataUnavailable, type AccountData } from "@/lib/accounts/data";
import { createMemoryAccountData } from "@/lib/accounts/memory";
import { handleNotify, NOTIFY_MAX_BODY_BYTES } from "@/lib/api/notify";
import { captureConsole, fakeClock, postRequest, PUBLIC_ORIGIN, testDeps, type RequestOptions } from "../helpers/server-deps";

const notifyRequest = (body: unknown, o: RequestOptions = {}) => postRequest("/api/notify", body, o);
const ON_THE_LIST = { ok: true, message: "You're on the list. We will email you when paid plans start." };

describe("POST /api/notify", () => {
  // Fails if the same-origin precondition is skipped, or a refused request still stores the address.
  it("refuses a cross-origin POST with 403 and stores nothing", async () => {
    const d = testDeps();
    for (const o of [
      { fetchSite: "cross-site", origin: "https://evil.example" },
      { fetchSite: null, origin: "https://evil.example" },
      { fetchSite: null, origin: null },
    ]) {
      const res = await handleNotify(notifyRequest({ email: "victim@example.test" }, o), d);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "cross_origin", message: "Open Retrofit at its own address to join the list." });
    }
    expect(d.accountsBacking.notify.size).toBe(0);
  });

  // Fails if Origin equal to PUBLIC_ORIGIN (no Sec-Fetch-Site) is refused.
  it("accepts Origin equal to PUBLIC_ORIGIN", async () => {
    const d = testDeps();
    const res = await handleNotify(notifyRequest({ email: "o@example.test" }, { fetchSite: null, origin: PUBLIC_ORIGIN }), d);
    expect(res.status).toBe(200);
  });

  // Fails if a body over 2 KB is read and stored, whether Content-Length declares it or not, or a 2 KB body is refused.
  it("answers 413 for a body over 2 KB and accepts one of exactly 2 KB", async () => {
    const d = testDeps();
    const exact = (n: number) => {
      const head = JSON.stringify({ email: "big@example.test", pad: "" });
      return head.replace('"pad":""', `"pad":"${"x".repeat(n - head.length)}"`);
    };
    expect(NOTIFY_MAX_BODY_BYTES).toBe(2048);
    const over = await handleNotify(notifyRequest(exact(2049)), d);
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: "too_large", message: "That request is too large." });
    const declared = notifyRequest(exact(100));
    const lying = new Request(declared, { headers: new Headers([...declared.headers, ["content-length", "5000"]]) });
    expect((await handleNotify(lying, d)).status).toBe(413);
    expect(d.accountsBacking.notify.size).toBe(0);
    expect((await handleNotify(notifyRequest(exact(2048)), d)).status).toBe(200);
  });

  // Fails if an invalid address, a missing or non-string email, or a body that is not JSON is stored or answered 200.
  it.each([[{ email: "not-an-email" }], [{ email: "a@b" }], [{ email: 42 }], [{}], [null], ["{not json"], [["a@example.test"]]])("answers 400 for %j and stores nothing", async (body) => {
    const d = testDeps();
    const res = await handleNotify(notifyRequest(body), d);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email", message: "Enter a valid email address." });
    expect(d.accountsBacking.notify.size).toBe(0);
  });

  // Fails if one network can add more than NOTIFY_PER_CLIENT_HOUR signups an hour, the answer lacks the
  // window's end as retryAt, another network is blocked, or the window never ends.
  it("answers 429 with retryAt after 5 signups an hour from one network", async () => {
    const clock = fakeClock(Date.parse("2026-11-23T10:20:00.000Z"));
    const d = testDeps({ clock: clock.clock });
    for (let n = 0; n < 5; n++) expect((await handleNotify(notifyRequest({ email: `n${n}@example.test` }), d)).status).toBe(200);
    const limited = await handleNotify(notifyRequest({ email: "n5@example.test" }), d);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      error: "limit",
      message: "You reached the limit of 5 signups per hour. Try again at 11:00 UTC.",
      retryAt: "2026-11-23T11:00:00.000Z",
    });
    expect(d.accountsBacking.notify.has("n5@example.test")).toBe(false);
    expect((await handleNotify(notifyRequest({ email: "other@example.test" }, { ip: "198.51.100.77" }), d)).status).toBe(200);
    clock.set(Date.parse("2026-11-23T11:00:00.000Z"));
    expect((await handleNotify(notifyRequest({ email: "n5@example.test" }), d)).status).toBe(200);
  });

  // Fails if the answer reveals whether the address was already on the list (status, body or headers).
  it("answers a repeat signup exactly like a new one and changes nothing", async () => {
    const d = testDeps();
    const first = await handleNotify(notifyRequest({ email: "Same@Example.test", consent: false }), d);
    const repeat = await handleNotify(notifyRequest({ email: "same@example.TEST", consent: true }), d);
    for (const res of [first, repeat]) {
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(ON_THE_LIST);
    }
    expect([...repeat.headers]).toEqual([...first.headers]);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(d.accountsBacking.notify.size).toBe(1);
    expect(d.accountsBacking.notify.get("same@example.test")?.marketingConsent).toBe(false);
  });

  // Fails if consent is recorded for anything but an explicit true (an unticked box, a missing field, a string).
  it("stores the address in lower case with consent only for consent: true", async () => {
    const d = testDeps();
    await handleNotify(notifyRequest({ email: "  Ticked@Example.test ", consent: true }), d);
    await handleNotify(notifyRequest({ email: "absent@example.test" }), d);
    await handleNotify(notifyRequest({ email: "string@example.test", consent: "true" }), d);
    expect(d.accountsBacking.notify.get("ticked@example.test")?.marketingConsent).toBe(true);
    expect(d.accountsBacking.notify.get("absent@example.test")?.marketingConsent).toBe(false);
    expect(d.accountsBacking.notify.get("string@example.test")?.marketingConsent).toBe(false);
  });

  // Fails if a storage failure answers 200 (a lost signup) or the address reaches a log line.
  it("answers 503 when account data is unavailable and never logs the address", async () => {
    const lines: string[] = [];
    captureConsole(lines);
    const failing: AccountData = {
      ...createMemoryAccountData(),
      addNotifySignup: async () => {
        throw new AccountDataUnavailable("addNotifySignup", "request_failed");
      },
    };
    const unexpected: AccountData = {
      ...createMemoryAccountData(),
      addNotifySignup: async (email) => {
        throw new Error(`duplicate key value (email)=(${email})`);
      },
    };
    for (const accounts of [failing, unexpected]) {
      const res = await handleNotify(notifyRequest({ email: "private.person@example.test" }), testDeps({ accounts }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable", message: "Retrofit could not save your address. Try again in a few minutes." });
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("private.person");
  });
});
