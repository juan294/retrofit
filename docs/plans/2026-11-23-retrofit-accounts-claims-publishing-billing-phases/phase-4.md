# Phase 4: publishing and the badge

Parent plan: [2026-11-23-retrofit-accounts-claims-publishing-billing.md](../2026-11-23-retrofit-accounts-claims-publishing-billing.md).

## Entry conditions

- Phase 3 accepted (or continuation authorized). Rebase on current `develop`.

## Changes

### Publishing (one implementer)

```
@ publish(account, host) -> published site
ctx: AccountData, latest ready analysis of the host owned by the account, generateNetwork(target "bundle")
pre: verified claim for host held by the account
do:
  1. lookup the newest ready analysis for host owned by the account
  2. validate the generated network (vendored validator) before writing
  3. write published_sites (snapshot, report, published_at or refreshed_at)
fail: no ready analysis -> 409 with "Analyze <host> first"; generation failed -> keep the previous snapshot, store last_refresh_error
```

- `src/app/s/[host]/page.tsx`: the public report and `AgentPanel` with `basePath="/s/<host>"`, the line "Published by the verified owner of <host>. Saved on <date>." and no unofficial label.
- `src/app/s/[host]/[...file]/route.ts`: the agent files (`agent-manifest.json`, network, `site-content.json`, `links.json`, `content-actions.js`, `bridge/*`) for a published, non-lapsed host; 404 otherwise. Agent JSON files carry `Access-Control-Allow-Origin: *` (the bundle's hosting rules), so other agent sites can call the published network.
- `src/proxy.ts`: exclude `s/[^/]+/bridge/` like `p/[^/]+/bridge/`.
- Account page: Publish, Refresh (after a new analysis), Unpublish.
- `sitemap.ts`: published hosts listed; unpublished or lapsed removed.

### Unit B `[batch-eligible]`: badge

Files: `src/lib/badge/svg.ts`, `src/app/badge/[file]/route.ts`, `tests/badge/*.test.ts`.

- `GET /badge/<host>.svg`: the score from `published_sites.report`; fixed text and digits only; `Cache-Control: public, max-age=3600`; `Access-Control-Allow-Origin: *`; 404 for unknown, unpublished or lapsed hosts.
- Account page shows the embed snippet: `<a href="https://retrofit.thecreativetoken.com/s/<host>"><img src="https://retrofit.thecreativetoken.com/badge/<host>.svg" alt="Agent-ready score by Retrofit"></a>`.

## Tests (TDD, red first)

- `tests/publish/*.test.ts`: publish needs a verified claim held by the account; refresh keeps the old snapshot on failure; unpublish and lapse give 404 on the page, the files and the badge.
- Oracle: the published manifest and network pass `build_network.mjs` byte for byte for every fixture site (extend `tests/bundle/oracle.test.ts`); no file contains `/api/inference`.
- `e2e/publish.spec.ts`: claim, publish, open `/s/<host>` in a new context without cookies, see the report and the key panel; connect a mock key, ask one question, see a tool round trip; `check_partner.mjs` on `/s/<host>/<network>` exits 0.
- `tests/badge/svg.test.ts`: the hostile fixture's host and text never appear; the score renders for 0, 7 and 100; headers.

## Exit criteria

- Parent success criteria 5 and 6 pass; 9 for `/s/<host>`.
- Full gate, analyzer ACCEPTED, required tests updated.
- Review, repair, simplify, handoff. Stop for acceptance. Owner manual check 3 after the release that includes it.
