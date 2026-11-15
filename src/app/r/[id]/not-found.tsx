import { visitorTexts } from "@/lib/analysis/texts";

export default function AnalysisNotFound() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-2xl font-semibold">Analysis not available</h1>
      <p className="mt-4">{visitorTexts.otherBrowser}</p>
      <p className="mt-6">
        <a href="/" className="underline">
          Analyze a site
        </a>
      </p>
    </main>
  );
}
