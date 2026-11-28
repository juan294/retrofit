/** The caller supplies the generator's validated host and ISO date. */
export function assistantHtml(host: string, date: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${host} assistant</title>
  <link rel="stylesheet" href="assistant.css">
  <script type="module" src="site.js"></script>
  <style>
    body { margin: 0 auto; max-width: 1100px; padding: 24px 16px; font: 16px/1.5 system-ui, sans-serif; }
    #agent-app .rf-icon { display: inline-block; flex: none; vertical-align: -0.125em; }
  </style>
</head>
<body>
  <main id="assistant" class="assistant">
    <h1>Ask ${host}</h1>
    <p>Answers come from the public pages of <a href="/">${host}</a>, saved on ${date}. Follow the source links to order, book or pay.</p>
    <p class="assistant-note">Your messages and the page data the assistant reads go to the AI provider you choose.</p>
    <p id="assistant-status" role="status">Connecting the assistant…</p>
    <div id="agent-app">
      <div data-ns-slot="header"></div>
      <div class="assistant-panels">
        <div data-ns-slot="chat"></div>
        <div data-ns-slot="agents"></div>
      </div>
      <div data-ns-slot="settings"></div>
    </div>
  </main>
</body>
</html>
`;
}

export function assistantScript(host: string, date: string): string {
  return `import { watchEmoji } from "./runtime-icons.js";

const root = new URL("../", import.meta.url);
const status = document.querySelector("#assistant-status");
// The runtime writes emoji as icons; runtime-icons.js shows line icons in their place.
watchEmoji(document.querySelector("#agent-app"));
try {
  const { boot } = await import("../runtime/index.js");
  const { engine } = await boot("#agent-app", {
    originUrl: root.href,
    sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", root).href,
  });
  if (!engine.byokKey || engine.byokKey === "demo") {
    status.textContent = "Assistant needs your AI provider key. Add it in AI model settings below.";
  } else {
    status.textContent = "Assistant connected to this page.";
    const greeting = document.querySelector("#ns-msgs .ns-msg.bot");
    if (greeting) greeting.textContent = "I answer questions about ${host} from its public pages, saved on ${date}.";
  }
} catch (error) {
  status.textContent = "The assistant could not load. You can still use the site directly.";
  console.error("Assistant startup failed", error);
}
`;
}
