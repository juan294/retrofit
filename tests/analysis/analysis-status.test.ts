import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { visitorTexts } from "@/lib/analysis/texts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
const { AnalysisStatus, AnalysisView } = await import("@/components/analysis/AnalysisView");

describe("the analysis status (UX-M2)", () => {
  // Fails if the results page has no status region before the first answer, or more than one.
  it("is one region, mounted from the first render", () => {
    const html = renderToStaticMarkup(createElement(AnalysisView, { id: "0".repeat(32), inputOrigin: "https://shop.example.com" }));
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="analysis-progress"');
    expect(html).toContain("Getting the analysis status");
    expect(html).toMatch(/<svg[^>]+aria-hidden="true"/);
  });

  // Fails if the region goes away between the progress and the report, so that the end of the analysis is silent.
  it("shows the progress, then says that the report is ready", () => {
    const html = (p: Parameters<typeof AnalysisStatus>[0]) => renderToStaticMarkup(createElement(AnalysisStatus, p));
    const queued = html({ state: "working", status: { status: "queued", step: "queued", scoreReady: false } });
    expect(queued).toMatch(/^<div role="status">.*data-testid="analysis-progress"/);
    expect(queued).toContain(visitorTexts.queued);
    expect(html({ state: "working", status: { status: "crawling", step: "page 8", scoreReady: false } })).toContain("Reading linked pages (page 8)");
    expect(html({ state: "working", status: { status: "ready", step: "done", scoreReady: true } })).toContain("Preparing your report");
    expect(html({ state: "ready", status: null })).toBe('<div role="status"><p class="sr-only">The report is ready.</p></div>');
    // A failure is an alert of its own.
    expect(html({ state: "failed", status: null })).toBe('<div role="status"></div>');
  });
});
