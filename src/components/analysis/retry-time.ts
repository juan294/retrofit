/**
 * Server texts give retry times as "HH:MM UTC". When the body also carries
 * `retryAt`, show that moment in the visitor's own time zone instead.
 */
export function localizeRetry(message: string, retryAt: string | undefined, locale?: string): string {
  if (!retryAt) return message;
  const at = new Date(retryAt);
  if (Number.isNaN(at.getTime())) return message;
  const local = at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return message.replace(/\b\d{2}:\d{2} UTC\b/, local);
}
