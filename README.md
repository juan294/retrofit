# Retrofit

Retrofit turns an existing website into an agentic website without a rebuild. Live: **https://retrofit.thecreativetoken.com**

Paste a public URL. Retrofit reads the site, scores how ready it is for AI agents, builds a working agent for that site that runs in the browser, and gives the plan and the files to install it. The site keeps its pages; the agent is files on the owner's own site, or a page that Retrofit hosts for a verified owner.

Retrofit is an entry for the [Open Agentic Web Challenge](https://cognizant-agenticweb.devpost.com/). It follows the open agentic web specification in [cognizant-ai-labs/agentic-web](https://github.com/cognizant-ai-labs/agentic-web), and it is itself an agentic site: its assistant scores websites for you, and other agents can call it.

## Try it

1. Open the [home page](https://retrofit.thecreativetoken.com) and enter a website's address.
2. Read the score: each check says what was read, why it matters and how to fix it.
3. Talk to the preview agent below the score. It answers from the site's public pages, on Retrofit's AI within its free limits or on your own AI key. Your key stays in your browser.
4. Download the files, and follow their README to install the assistant on a site you own.

Judges: enter your code on [/judges](https://retrofit.thecreativetoken.com/judges). Everything is free for everyone until the end of 2027-01-19 (UTC).

With a free account (sign in by email link, no password) you can also save a report, prove that a site is yours by a meta tag or a DNS record, publish its agent and report on Retrofit, and show a badge on your site.

## For agents

- The manifest is [`/agent-manifest.json`](https://retrofit.thecreativetoken.com/agent-manifest.json). The network `retrofit_guide` has the read-only tool `website_score_site` and shares it with partner sites.
- `GET /api/score?url=<public website address>` returns the score as JSON. [/bot](https://retrofit.thecreativetoken.com/bot) describes the crawler, its limits and the API.

## How it works

- **Next.js 16** (App Router) with a per-request content security policy. The request hook is `src/proxy.ts`.
- **Reading a site** (`src/lib/fetch`, `src/lib/crawl`): robots rules, one request per second and host, size and time limits, and an address guard against private networks. Fetched content is data, never instructions.
- **Score** (`src/lib/score`): 16 deterministic checks, no model.
- **Agent** (`src/lib/generate`): a validated agent network for the site. The organizers' runtime is vendored unchanged in `public/runtime` and `tools/agentic-web`, and runs it in the visitor's browser.
- **Data**: Supabase Postgres behind the service role only. Supabase Auth verifies sign-in links; Retrofit issues its own host-locked session.
- **Safety**: a preview of a site that nobody claimed is private and labelled unofficial. The runtime contacts another site only after consent.

## Develop

Node 24 and pnpm 12.

```sh
pnpm install
pnpm dev          # http://127.0.0.1:3009, memory store, no provider needed
pnpm typecheck && pnpm lint && pnpm test
pnpm build && pnpm test:e2e
pnpm test:db      # disposable Supabase stack, needs Docker and the Supabase CLI
```

`python3 .rpi/scripts/rpi-verify.py` runs the whole gate in order. Contributor rules are in [AGENTS.md](AGENTS.md), decisions in [docs/decisions](docs/decisions), and the release procedure in [docs/release/release-playbook.md](docs/release/release-playbook.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) (the vendored runtime is the organizers' work).
