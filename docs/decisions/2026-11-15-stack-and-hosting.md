# Stack and hosting

Owner and planner decisions, 2026-11-15, from the accepted plan `docs/plans/2026-11-15-retrofit-url-to-preview.md` (revision 5). Recorded in Phase 1.

## Owner decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Stack | Next.js 16 (App Router) on Vercel, pnpm, Node 24, TypeScript 6, ESLint 9, Vitest 4, Playwright, Tailwind 4 | One deployment serves pages, API routes and static agent artifacts. The owner's fleet uses the same tools. |
| Free inference | Hosted Otari with the hackathon credits, model `alibaba/qwen3.8-flash`, behind a Retrofit endpoint with spend caps | Judges and visitors without a key can use the product. |
| Production storage | Supabase Postgres; an in-memory store with the same contract for tests and local development | Atomic primitives (leases, compare-and-set, queues) on a managed database. |
| Second origins | `demo-*.thecreativetoken.com`; this plan publishes `demo-harbor.thecreativetoken.com` | Spec §6 needs a peer on a second production origin. |
| Key panel style | New neutral style | See `2026-11-15-open-source-and-key-panel-style.md`. |
| Open source | Whole project, Apache-2.0, public since 2026-11-15 | Hackathon rule. |
| Key origin | `retrofit.thecreativetoken.com` serves first-party code only. No third-party script may run on it. Pages that need third-party scripts go on another origin. | A visitor's LLM key lives in this origin's browser storage. |
| Judge access | Judge reserve with hard public spend caps through 2027-01-18, a judge code, a daily credit check, BYOK always available | Judges must have free access without restriction. The guarantee level is settled at Phase 6 acceptance. |
| Release scope | Full spec §6 in production before the first release, with `demo-harbor` | Conformance evidence. |

## Planner decisions

- Networks are generated deterministically from fixed templates. No LLM builds them.
- The organizers' runtime is vendored unchanged at commit `63a956cf4653f610b1c238c70946f4d7647d17a8` with a checksum manifest (`vendor/agentic-web.json`). Containment lives in Retrofit's adapter, never in vendored files.
- CSP: `script-src 'self' 'nonce-<n>'` with no `'strict-dynamic'`; `style-src 'self' 'unsafe-inline'` because the runtime inserts a `<style>` element and inline style attributes; exact `connect-src` lists built in one function (`buildConnectSrc`).
- The local gate is the source of truth. A proposed CI workflow goes to Sutura (`docs/development/ci-handoff.md`); this repository adds no `.github/`.
- First production deploy with `vercel deploy --prod` before Git is connected; afterwards Git deploys only `main`.
- Ports: dev 3009, Playwright server 3010, test origins 3011 and 3013, merchant spike 3012, performance server 3014. Supabase: dev stack 54720 to 54729, disposable gate stack 54730 to 54739.

## Facts recorded in Phase 1

- Next.js 16.4.6 names the request hook `proxy` (`src/proxy.ts`); `middleware` is the older name. VERIFIED from `node_modules/next/dist/lib/constants.js:289` and the bundled CSP guide.
- pnpm 12.15.0 is installed on the development machine, not pnpm 10 as the plan said. `packageManager` pins `pnpm@12.15.0`. See the plan notes.
- `next build` type-checks with `tsconfig.build.json` (application source only). `pnpm typecheck` checks everything, including tests.
