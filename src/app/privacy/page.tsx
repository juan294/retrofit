import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";
import { PRIVACY } from "@/lib/site/legal-texts";

export const metadata: Metadata = { title: "Privacy · Retrofit" };

export default function PrivacyPage() {
  return <LegalPage doc={PRIVACY} />;
}
