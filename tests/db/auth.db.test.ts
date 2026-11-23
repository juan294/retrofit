/**
 * The Supabase Auth gateway against the real Auth service of the disposable gate stack
 * (`pnpm test:db`): a real signInWithOtp reaches the local mail catcher (Mailpit), the emailed
 * link carries the token hash to /auth/confirm, and the token verifies exactly once. This is
 * the contract probe for the recorded provider answers in tests/accounts/auth-supabase.test.ts.
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { AuthRateLimited } from "@/lib/auth/gateway";
import { createSupabaseAuthGateway } from "@/lib/auth/supabase";
import { createServiceClient } from "@/lib/supabase/client";

const url = process.env.SUPABASE_GATE_URL;
const serviceRoleKey = process.env.SUPABASE_GATE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_GATE_ANON_KEY;
const mailUrl = process.env.SUPABASE_GATE_MAIL_URL;
if (!url || !serviceRoleKey || !anonKey || !mailUrl) {
  throw new Error(
    "tests/db/auth.db.test.ts needs SUPABASE_GATE_URL, SUPABASE_GATE_SERVICE_ROLE_KEY, SUPABASE_GATE_ANON_KEY and SUPABASE_GATE_MAIL_URL from a disposable Supabase stack with Auth and the mail catcher. Run it through pnpm test:db.",
  );
}

const gateway = createSupabaseAuthGateway({ url, anonKey, admin: createServiceClient({ url, serviceRoleKey }) });

interface MailSummary {
  ID: string;
}

interface Mail {
  ID: string;
  HTML: string;
  Subject: string;
}

/** The newest message to `email` in the mail catcher other than `seen`, waiting up to 15 s for it. */
async function latestMessage(email: string, seen?: Mail): Promise<Mail> {
  const until = Date.now() + 15_000;
  for (;;) {
    const res = await fetch(`${mailUrl}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const list = (await res.json()) as { messages?: MailSummary[] };
    const id = list.messages?.[0]?.ID;
    if (id && id !== seen?.ID) return (await (await fetch(`${mailUrl}/api/v1/message/${id}`)).json()) as Mail;
    if (Date.now() > until) throw new Error("no sign-in email reached the mail catcher");
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Fails if the provider does not email a link to Retrofit's confirm route with the token hash, if the
// token does not verify to the same account, if a used token verifies again, or if the provider's
// resend refusal is not mapped to AuthRateLimited.
it("a real sign-in email reaches the mail catcher and its link's token verifies exactly once", async () => {
  const email = `auth-${randomUUID()}@example.test`;
  await gateway.signInWithOtp(email, "http://127.0.0.1:3010/auth/confirm");
  const message = await latestMessage(email);
  expect(message.Subject).toBe("Your Retrofit sign-in link");
  const link = /href="([^"]+)"/.exec(message.HTML)?.[1]?.replaceAll("&amp;", "&");
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:3009\/auth\/confirm\?token_hash=[0-9a-f]+&type=email$/);
  const tokenHash = new URL(link as string).searchParams.get("token_hash") as string;

  const first = await gateway.verifyOtp(tokenHash, "email");
  expect(first).toEqual({ ok: true, userId: expect.stringMatching(/^[0-9a-f-]{36}$/), email });
  expect(await gateway.verifyOtp(tokenHash, "email")).toEqual({ ok: false, reason: "expired" });
  expect(await gateway.verifyOtp("0".repeat(56), "email")).toEqual({ ok: false, reason: "expired" });

  // An immediate resend is refused by the provider's per-address frequency (max_frequency, 1 s on the
  // local stacks, 60 s by default in production) as AuthRateLimited, which sign-in shows as a short wait.
  await expect(gateway.signInWithOtp(email, "http://127.0.0.1:3010/auth/confirm")).rejects.toBeInstanceOf(AuthRateLimited);
  // After that wait the same address signs in again to the same account (no second user).
  await new Promise((r) => setTimeout(r, 1500));
  await gateway.signInWithOtp(email, "http://127.0.0.1:3010/auth/confirm");
  const again = await latestMessage(email, message);
  const secondHash = new URL((/href="([^"]+)"/.exec(again.HTML)?.[1] ?? "").replaceAll("&amp;", "&")).searchParams.get("token_hash") as string;
  expect(secondHash).not.toBe(tokenHash);
  const second = await gateway.verifyOtp(secondHash, "email");
  expect(second.ok && second.userId).toBe(first.ok && first.userId);
}, 60_000);

// Fails if account deletion's pre-check cannot see the user, the user survives deleteUser, or a retry fails.
it("getUser finds the account and deleteUser removes it, twice without error", async () => {
  const email = `delete-${randomUUID()}@example.test`;
  await gateway.signInWithOtp(email, "http://127.0.0.1:3010/auth/confirm");
  const message = await latestMessage(email);
  const tokenHash = new URL((/href="([^"]+)"/.exec(message.HTML)?.[1] ?? "").replaceAll("&amp;", "&")).searchParams.get("token_hash") as string;
  const verified = await gateway.verifyOtp(tokenHash, "email");
  if (!verified.ok) throw new Error("verification failed");
  expect(await gateway.getUser(verified.userId)).toEqual({ userId: verified.userId, email });
  await gateway.deleteUser(verified.userId);
  expect(await gateway.getUser(verified.userId)).toBeNull();
  await gateway.deleteUser(verified.userId);
}, 60_000);
