/** Reads at most `maxBytes` of the request body; "too large" past that, whatever Content-Length said. */
export async function readLimitedBody(request: Request, maxBytes: number): Promise<string | "too large"> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return "too large";
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return "too large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
