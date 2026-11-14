# Retrofit release procedure

This is the single release procedure for Retrofit. Native `rpi-release` delegates to it. Repository setup is not a release. Juan owns publication, hosting, provider and rollback decisions.

## Present readiness

The repository holds workspace setup only. There is no application code, test suite, deployment target or candidate-bound evidence. Release readiness is **BLOCKED**. The setup checks can pass while this stays true. Do not report a test count or a coverage percentage that no suite produced.

Machine-readable selection and gaps are in `.rpi/release-profile.json`. The product plan must supply executable checks and the evidence analyzer described below before the first release. Installing RPI does not implement them.

## Adaptation profile

| Area | Retrofit decision |
| --- | --- |
| Product | Web tool and browser runtime that conforms to the open agentic web specification. Stack not decided. |
| Repository | `juan294/retrofit`. Private at bootstrap. The hackathon requires open source, so visibility must change before submission, with Juan's authorization. |
| Branches | `develop` integration, `main` production, merge-commit promotion |
| Artifact | Not decided. Expected: one deployed site at `retrofit.thecreativetoken.com` plus the published runtime and manifest files, each tied to a source commit. |
| State | Not decided. Expected: accounts, saved reports and site claims. Visitor LLM keys stay in the browser and are never server state. |
| Network | Reads third-party public sites through a server-side fetch service. Calls LLM providers from the browser. |
| Release owner | Juan |
| Rollback | Restore the previous verified deployment with owner authorization. Decide the exact mechanism with the hosting choice. |
| Hosted CI | None configured at bootstrap. Sutura owns fleet CI routing. |
| Deadline | Submission closes 2027-01-11 8:00 am PT. Judges need free access until 2027-01-18. |
| Wave A | Mandatory: fixed candidate, nonempty passing evidence, required miss blocks, tag last. |
| Wave B | Not selected. Retrofit ships no code that runs unattended or destructively on users' machines. Reassess if that changes. |
| Waves C to H | Reassess after the product plan fixes the stack, the data model and the payment scope. |

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
