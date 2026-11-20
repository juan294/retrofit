/**
 * Normalizes the dynamic values in captured runtime request bodies (analysis ids, call ids,
 * UUIDs, timestamps and the snapshot date in the generated instructions), so a rerun on the
 * same vendored runtime writes the same capture on any day.
 */
export function normalizeCapture(text: string): string {
  return text
    .replaceAll(/http:\/\/127\.0\.0\.1:3010\/p\/[0-9a-f]{32}/g, "http://127.0.0.1:3010/p/ANALYSIS_ID")
    .replaceAll(/call_\d+_\d+/g, "call_ID")
    .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "UUID")
    .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "TIMESTAMP")
    .replaceAll(/taken on \d{4}-\d{2}-\d{2}/g, "taken on SNAPSHOT_DATE");
}
