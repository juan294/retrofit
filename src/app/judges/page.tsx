import type { Metadata } from "next";
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
        Enter the judge code to use the judges&apos; share of Retrofit&apos;s free AI in this browser. You can also paste your own key in AI
        settings instead.
      </p>
      <JudgeForm />
    </main>
  );
}
