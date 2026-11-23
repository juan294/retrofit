// The badge image: fixed words and the score's digits. It takes a number and nothing else, so no
// host, page title or other site text can reach it.

/** The badge's one line. A score that is not an integer from 0 to 100 (also "No score") shows no number. */
function badgeLine(score: number | null): string {
  const valid = typeof score === "number" && Number.isInteger(score) && score >= 0 && score <= 100;
  return `Agent-ready ${valid ? `${score}/100` : "check"} · verified by Retrofit`;
}

/** The badge SVG, sized to its line. Colors are fixed, so it reads the same on a light or a dark page. */
export function badgeSvg(score: number | null): string {
  const line = badgeLine(score);
  const text = Math.round(line.length * 6.4);
  const width = text + 20;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="24" viewBox="0 0 ${width} 24" role="img" aria-label="${line}">`,
    `<title>${line}</title>`,
    `<rect width="${width}" height="24" rx="4" fill="#1f2933"/>`,
    `<text x="10" y="16" fill="#ffffff" font-family="Verdana, Geneva, sans-serif" font-size="11" textLength="${text}" lengthAdjust="spacingAndGlyphs">${line}</text>`,
    "</svg>",
  ].join("");
}
