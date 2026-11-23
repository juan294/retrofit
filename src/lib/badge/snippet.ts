const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

/** The badge's embed HTML for a published host: the image, linking to the public page. */
export function badgeSnippet(origin: string, host: string): string {
  return `<a href="${escapeHtml(`${origin}/s/${host}`)}"><img src="${escapeHtml(`${origin}/badge/${host}.svg`)}" alt="Agent-ready score by Retrofit"></a>`;
}
