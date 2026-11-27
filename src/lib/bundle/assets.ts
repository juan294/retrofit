import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { prepareZipData } from "./zip";

async function asset(name: string, file: string) {
  const bytes = await readFile(file);
  return { path: name, bytes, prepared: prepareZipData(bytes) };
}

async function readAssets() {
  const runtime = path.join(process.cwd(), "public/runtime");
  const files = await readdir(runtime, { recursive: true, withFileTypes: true });
  const runtimeFiles = files.filter(file => file.isFile()).map(file => {
    const diskPath = path.join(file.parentPath, file.name);
    const relative = path.relative(runtime, diskPath).split(path.sep).join("/");
    return asset("runtime/" + relative, diskPath);
  });
  const assets = await Promise.all([
    ...runtimeFiles,
    asset("content-actions.js", path.join(process.cwd(), "public/preview-assets/content-actions.js")),
    asset("bridge/action-bridge.html", path.join(process.cwd(), "public/preview-assets/bridge/action-bridge.html")),
    asset("assistant/assistant.css", path.join(process.cwd(), "tools/agentic-web/templates/assistant.css")),
    // Retrofit's icons in place of the runtime's emoji; site.js starts them before the runtime boots.
    asset("assistant/runtime-icons.js", path.join(process.cwd(), "public/brand/runtime-icons.js")),
  ]);
  return assets.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

let cached: ReturnType<typeof readAssets> | undefined;

/** Concurrent downloads share one load. A failed read can be retried by the next request. */
export function bundleAssets() {
  return cached ??= readAssets().catch(error => {
    cached = undefined;
    throw error;
  });
}
