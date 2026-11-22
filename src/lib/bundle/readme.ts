import { LEAD_EMAIL } from "@/lib/site/own-site";

export function bundleReadme(host: string, date: string, sitePaths: string[]): string {
  return `# Install the ${host} assistant

This bundle is for a site you own. It adds a page that answers questions from the public pages of ${host} saved on ${date}.

## Before you copy

Check each path below against your web root, including hidden files. Stop if \`runtime/\`, \`bridge/\` or \`assistant/\` already exists, if any directory you need is already a file, or if any listed file already exists. You can use an existing \`.well-known/\` directory when both discovery filenames are free. For a conflict, email ${LEAD_EMAIL} before copying. Keep a backup of your site's files and hosting configuration.

${sitePaths.map((path) => "- `site/" + path + "`").join("\n")}

## Install

1. Copy the contents of the \`site/\` folder into the web root, including \`.well-known/\`. Keep the README and the \`hosting/\` folder outside the web root.
2. Merge the rules for your host into its existing configuration. Use \`hosting/_headers\` in the root \`_headers\` file on Netlify or Cloudflare Pages, \`hosting/htaccess-snippet.txt\` in the root \`.htaccess\` on Apache, or \`hosting/vercel-headers.json\` in the project's \`vercel.json\` on Vercel. Apply the CORS rules only to the listed public files. Allow other sites to frame \`bridge/action-bridge.html\`. If your site has a content security policy, allow your AI router in \`connect-src\`.
3. Publish over HTTPS and open \`/assistant/\`. Ask a question and follow the source link. Add a link to \`/assistant/\` in your site's menu.

## What visitors need

Visitors enter their own AI provider key in AI model settings and choose **Save and start**. The default router is Otari. To change the default, edit \`llm_router.base_url\`, \`llm_router.byok_router\` and \`llm_router.model\` in \`agent-manifest.json\`. Set the same model in the network file's \`llm_config.model_name\`. Choose a router that supports browser requests and a model that supports tool calls.

## What data leaves the page

The visitor's browser sends their messages and the public page data the assistant reads to their chosen AI provider. The browser stores the visitor's key for this site and sends it to the selected router. Keep third-party scripts off the assistant page. After testing, use **Delete setup** in the advanced settings and close the tab.

## Keep it current

The snapshot is from ${date}. When the site changes, analyze it again, download a fresh bundle and review the files before replacing the ones you installed.

## Get help

Email ${LEAD_EMAIL} for installation help. Built by [Retrofit](https://retrofit.thecreativetoken.com/).

The vendored runtime uses the Apache-2.0 license. See \`site/runtime/LICENSE.txt\`.
`;
}

export function hostingFiles(networkName: string): Record<string, string> {
  const publicPaths = ["/agent-manifest.json", `/${networkName}.network.json`, "/links.json", "/agent-mcp.json", "/.well-known/nsdeploy.json", "/.well-known/nsdeploy-agent.json"];
  const worker = "/runtime/sandbox-worker.js";
  const policy = "default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'";
  const rules = [
    ...publicPaths.map((source) => ({ source, headers: [{ key: "Access-Control-Allow-Origin", value: "*" }] })),
    { source: worker, headers: [{ key: "Content-Security-Policy", value: policy }] },
  ];
  const apachePaths = publicPaths.map((path) => path.replaceAll(".", "\\.")).join("|");
  return {
    "hosting/_headers": rules.map(({ source, headers: [header] }) => `${source}\n  ${header!.key}: ${header!.value}\n`).join(""),
    "hosting/vercel-headers.json": JSON.stringify({ headers: rules }, null, 2) + "\n",
    "hosting/htaccess-snippet.txt": `<IfModule mod_headers.c>
  SetEnvIf Request_URI "^(${apachePaths})$" assistant_public
  SetEnvIf Request_URI "^/runtime/sandbox-worker\\.js$" assistant_worker
  Header always set Access-Control-Allow-Origin "*" env=assistant_public
  Header always set Content-Security-Policy "${policy}" env=assistant_worker
</IfModule>
`,
  };
}
