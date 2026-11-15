# Retrofit release procedure

This is the single release procedure for Retrofit. Native `rpi-release` delegates to it. Repository setup is not a release. Juan owns publication, hosting, provider and rollback decisions.

## Present readiness

The application is built through Phase 7's local work (`docs/plans/2026-11-15-retrofit-url-to-preview-notes.md`). Release readiness is **BLOCKED** until the Phase 7 external actions are authorized and done (hosting, database, domains, production evidence), the owner's Phase 6 inputs exist (Otari key, prices, credit, reserve, judge code, contract probe) and the `rpi-installation` gate check passes again. Do not report a test count or coverage that the current gate run did not produce.

Machine-readable selection and gaps are in `.rpi/release-profile.json`.

## Adaptation profile

| Area | Retrofit decision |
| --- | --- |
| Product | Next.js 16 web tool and the vendored agentic-web browser runtime (`docs/decisions/2026-11-15-stack-and-hosting.md`). |
| Repository | `juan294/retrofit`. Public since 2026-11-15, by Juan's authorization. |
| Branches | `develop` integration, `main` production, merge-commit promotion. |
| Artifact | One Vercel production deployment of the merge commit on `main`, serving `retrofit.thecreativetoken.com` and, host-routed, `demo-harbor.thecreativetoken.com`. `/api/version` reports the commit (`BUILD_COMMIT`). |
| State | Supabase Postgres project `retrofit`: crawl jobs, visitor-owned analyses (7 days), free-inference sessions, quotas, the ledger and the overrun hold. Visitor LLM keys stay in the browser and are never server state. |
| Network | Server: guarded fetch of public sites (robots, pacing, SSRF guard) and the Otari upstream for the free path. Browser: the visitor's provider router or Retrofit's free path, and consented peers. |
| Release owner | Juan |
| Rollback | First release: remove the production aliases with owner authorization. Later releases: `vercel rollback <previous deployment>` with owner authorization; the database keeps its data (no destructive migration in this plan). |
| Hosted CI | None in this repository. Sutura owns fleet CI routing (`docs/development/ci-handoff.md`). |
| Deadline | Submission closes 2027-01-11 8:00 am PT. Judges need free access until 2027-01-18. |
| Wave A | Mandatory: fixed candidate, nonempty passing evidence, required miss blocks, tag last. |
| Wave B | Not selected. Retrofit ships no code that runs unattended or destructively on users' machines. |
| Waves C to H | Reassess before the second plan's release. |

### Wave A commands for this stack

1. Candidate: merge `develop` into `main` locally with a merge commit; `git status` clean.
2. Local gate on that commit: `python3 .rpi/scripts/rpi-verify.py` (includes `pnpm test:db`, the disposable gate database, and `pnpm test:e2e`).
3. Local analysis: `node tools/release/analyze-evidence.mjs <merge commit>`. Any accepted exception (`--accept-failed-check <name> --reason <text>`) is shown to Juan with the candidate.
4. After the authorized candidate deployment (`vercel deploy --prod --build-env BUILD_COMMIT=<merge commit>` from a clean checkout of that commit): production evidence into `.local/evidence/production/<deployment id>/` (phase-7.md "Production evidence"), then `node tools/release/analyze-evidence.mjs <merge commit> --production .local/evidence/production/<deployment id>`.
   - Deployment identity: `/api/version` names only a commit, and two deployments of one commit can differ. `tools/release/production-evidence.mjs` therefore runs `vercel inspect <target> --format json` for the deployment URL, `retrofit.thecreativetoken.com` and `demo-harbor.thecreativetoken.com` (the `aliases` of the `alias-binding` case in `tools/release/required-production-cases.json`) before the first case and again after the last. Each must name the candidate deployment id both times. A host bound to another deployment, or one that Vercel cannot inspect, fails `alias-binding`; when this happens before the suites, the script stops and runs no suite. The analyzer rejects a binding case without this identity and any case recorded outside the two checks.
5. Juan's final acceptance, then the release tag last through `rpi-release`.

## Required ordering

1. Confirm the exact release scope with Juan. Confirm a clean candidate, the integration and production refs, and the retained-resource state. Do not publish working branches.
2. Freeze the candidate commit and its dependency identities.
3. Run local checks sequentially with `.rpi/policy.json` and `.rpi/scripts/rpi-verify.py`. Add the real automated tests and coverage to the declared selection before any release. No required failure or skip may become a pass.
4. Prove conformance for the exact candidate: a valid `agent-manifest.json`, a runtime that runs the network in the browser, and an interface for users or agents. Use the organizers' validation script if one exists at that time. Record which version of the specification was checked.
5. Prove the safety rules: the visitor key never leaves the browser, robots rules and per-site limits hold, a preview of an unclaimed site is private and labelled unofficial, and consent comes before contact with a third-party origin.
6. Analyze the candidate's evidence with a tested analyzer. It must reject zero passes, missing, failed or skipped required probes, a mismatched commit, and missing cleanup. The analyzer is a first-release prerequisite and does not exist at bootstrap. A prose checklist cannot replace it.
7. Present the source identity, automated results, conformance and safety evidence, known issues and the rollback artifact to Juan. Get the authorization for the concrete publication action.
8. Promote the verified tree with a merge commit, confirm its identity, then create the release tag last through `rpi-release`. Publish only the authorized artifact and destination and inspect the exact result. Do not use a rerun or re-push loop to debug.

## Hackathon submission

The Devpost submission is an outward-facing action that needs Juan's authorization for the exact content. It needs a public URL, a video under 2 minutes on YouTube with Juan explaining and no third-party trademarks, a text description and screenshots. Making the repository public is a separate authorized action.

## Evidence and rollback

Keep raw logs, screenshots and fetched site copies under ignored `.local/` or `.rpi/local/`. Curated release summaries may live under `docs/release/`. Each result names the candidate commit, environment, time, command or procedure, outcome and cleanup disposition.

A key leak, a public page for an unclaimed site, or abuse of the fetch service after release requires stopping the rollout and presenting the exact rollback artifact and scope to Juan. Preserve the failure evidence and user data.
