import { agentSnapshot, type AgentSnapshot, type Snapshot } from "@/lib/snapshot/types";

/** A small valid snapshot of `host`, read at `fetchedAt` (ISO 8601); `text` marks its one page. */
export function snapshotOf(host: string, fetchedAt: string, text = "Open Monday to Friday."): Snapshot {
  const probe = { url: `https://${host}/x`, status: 404, contentType: "text/plain", body: "", accessControlAllowOrigin: null };
  return {
    version: "snapshot/v1",
    source: `https://${host}/`,
    inputUrl: `https://${host}/`,
    finalUrl: `https://${host}/`,
    host,
    fetchedAt,
    pages: [
      {
        url: `https://${host}/`,
        status: 200,
        truncated: false,
        title: "Shop",
        description: null,
        lang: "en",
        text,
        textTruncated: false,
        noindex: false,
        headers: {},
        jsonLd: [],
        jsonLdInvalid: 0,
        forms: [],
        links: [],
        records: {},
      },
    ],
    probes: { robots: probe, agentManifest: probe, llmsTxt: probe, sitemap: probe },
    skipped: [],
    records: {},
    excludedNoindex: [],
  };
}

/** The stored form of snapshotOf, as a publication keeps it. */
export const storedSnapshotOf = (host: string, fetchedAt: string, text?: string): AgentSnapshot => agentSnapshot(snapshotOf(host, fetchedAt, text));
