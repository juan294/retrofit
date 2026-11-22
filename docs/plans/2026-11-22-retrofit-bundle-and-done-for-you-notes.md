# Install bundle and contact implementation

Juan approved all three phases, local integration into develop and disposal of the implementation worktree. The base is `10ed45ded619b240340dd05c4712c4fa10a6ccb8`. The implementation branch is `feat/bundle-service` in `/Users/juan/code/retrofit-worktrees/bundle`. No project rpi-implement overlay is installed. The phase handoffs follow 2026-11-22-retrofit-bundle-and-done-for-you.md.

On 2026-11-22 the upstream HEAD was `e34299792cb85f6eb27fed896fdedf65880b458b`. Compared with the vendor pin `05165377aca457381bd41b5c05e7a26cd23e6d74`, only `docs/agentic_websites.md` changed.

## Deviations

The fixture crawl uses ephemeral ports and the current time. Preview byte pins use fixed host ports and a fixed snapshot time before generation.

## Phase 1

ZIP and file assembly were independent local assignments. The ZIP writer, bundle assembly and both generator targets passed their focused regressions. ZIP integrity and extraction use the Python standard library. The tests compare the complete vendored runtime and six generated artifacts per site against the upstream compiler. Preview regression pins were captured on the original generator, after normalizing the ephemeral crawl address, derived record IDs and date. An intentional preview wording change failed all five pins.

Independent review approved the implementation after P1-R1 was fixed. The README now names conflicting directories and configuration destinations. The new regression failed before the correction and passed after it. The simplify pass checked common generator logic, byte preparation and asset caching. Dynamic files use the same ZIP writer as the cached vendored entries. The typecheck caught an optional-byte narrowing error in the ZIP writer. Its correction passed the typecheck and all 15 ZIP regressions.

The phase gate runs on the commit containing this entry. The following phase records its exact verification receipt. The full gate owns the loopback servers and disposable gate database through their documented commands.

Phase 1 passed all 15 local checks on `1bc240bb1873f28de9b9d39da7a5e02b238cd923`. The analyzer accepted 1,245 unit, 2 performance, 45 database and 72 browser tests. Coverage was 94.10% for statements and 88.59% for branches. The database teardown completed. Each phase's raw receipt is retained under the canonical checkout's ignored `.local/runs/2026-11-22-bundle-service/` directory.

## Phase 2

At entry, `develop` was still `10ed45d`. The download returned 404 before implementation. The status and browser tests also failed before the ready flag and panel existed. Route tests now cover access, expiry, queued jobs, generation refusal and store errors. The full results response checks whether the snapshot can generate an install without contacting an AI provider. The compact polling response keeps its existing cost. The download uses the shared ownership and error paths and constructs just one target per request.

The browser downloaded and extracted the bakery ZIP, started the organizers' server on 3015, ran their partner checker, and scored the existing fixture home page with the installed files through Retrofit's public analyze flow in fixtures mode. All three agentic-web checks passed. Chromium connected a synthetic key through the installed page's settings, ran the snapshot search and displayed its source link. The fixture clock proved expiry hid the panel. At 320 pixels the results page had no horizontal overflow. Both themes passed the contrast checks. Twenty complete bakery downloads took 4.5 ms at p95 on the focused run, at 515,266 bytes each. Every fixture archive has a two-million-byte size assertion.

Independent review approved the phase and verified that the built route's trace includes all 38 runtime, action, bridge and CSS inputs. The simplify pass merged installation availability into the displayed report's state. Performance files now run sequentially because they measure the same server. The phase gate retests the resulting candidate. Port 3015 was free after the focused test. No owner UI commits arrived during the rebase.

### Phase 2 adjustments

The plan put access to the ZIP in the preview artifact resolver. The implemented branch runs after the shared owner and status checks and before preview generation, so a ZIP request builds the installed network only. The results response exposes install availability to hide the download when generation fails even if the visitor has no key. The install instructions specify the contents of the site folder to preserve root-relative URLs.
