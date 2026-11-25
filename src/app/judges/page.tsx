import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { JudgeForm } from "@/components/JudgeForm";

export const metadata: Metadata = {
  title: "Judges · Retrofit",
  robots: { index: false, follow: false },
};

export default async function JudgesPage() {
  // Render per request so that each response carries its own CSP nonce.
  await connection();
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-4xl font-semibold">Judges</h1>
      <p className="mt-4" style={{ color: "var(--color-muted)" }}>
        Enter the judge code to use the judges&apos; share of Retrofit&apos;s free AI in this browser. You can also use your own key instead:
        open &ldquo;Use your own AI key (optional)&rdquo; next to an agent.
      </p>
      <p className="mt-4" style={{ color: "var(--color-muted)" }}>
        You enter the code once. Judge access then stays on in this browser until judging ends, and the panel next to an agent shows that it is on.
      </p>
      <JudgeForm />
      <p className="mt-8">
        <Link href="/" className="underline">
          Go to the home page and analyze a site
        </Link>
      </p>
    </main>
  );
}
