import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";
import { TERMS } from "@/lib/site/legal-texts";

export const metadata: Metadata = { title: "Terms · Retrofit" };

export default function TermsPage() {
  return <LegalPage doc={TERMS} />;
}
