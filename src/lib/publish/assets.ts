// The files of Retrofit's own code that a published site serves, by their path under /s/<host>/. This is the
// one list: the file route answers these names only (files.ts) and next.config.ts traces these files only.

/** The modules the bridge page loads from ../runtime/ (a test follows their imports). */
export const BRIDGE_RUNTIME_FILES = ["action-bridge.js", "action-transport.js", "actions.js", "discovered-actions.js", "form-actions.js", "web-crypto.js"] as const;

/** Published path -> the file's path under public/. */
export const PUBLISHED_ASSETS: ReadonlyMap<string, string> = new Map([
  ["content-actions.js", "preview-assets/content-actions.js"],
  ["bridge/action-bridge.html", "preview-assets/bridge/action-bridge.html"],
  ...BRIDGE_RUNTIME_FILES.map((f): [string, string] => [`runtime/${f}`, `runtime/${f}`]),
]);
