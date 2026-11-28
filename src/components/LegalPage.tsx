import type { LegalDocument } from "@/lib/site/legal-texts";
import { SitePage } from "./SitePage";

/** Renders a privacy or terms document from src/lib/site/legal-texts.ts. */
export function LegalPage({ doc }: { doc: LegalDocument }) {
  return (
    <SitePage title={doc.title}>
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
    </SitePage>
  );
}
