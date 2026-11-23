import Link from "next/link";
import type { LegalDocument } from "@/lib/site/legal-texts";

/** Renders a privacy or terms document from src/lib/site/legal-texts.ts. */
export function LegalPage({ doc }: { doc: LegalDocument }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 leading-relaxed [overflow-wrap:anywhere]">
      <p>
        <Link href="/" className="underline">
          Retrofit
        </Link>
      </p>
      <h1 className="mt-4 text-3xl font-semibold">{doc.title}</h1>
      <p className="mt-4">{doc.intro}</p>
      {doc.sections.map((s) => (
        <section key={s.heading}>
          <h2 className="mt-8 text-xl font-semibold">{s.heading}</h2>
          {s.body.map((p) => (
            <p key={p} className="mt-2">
              {p}
            </p>
          ))}
        </section>
      ))}
    </main>
  );
}
