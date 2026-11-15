# Notes: Retrofit, from URL to live preview

Implementation notes for the plan `2026-11-15-retrofit-url-to-preview.md` and its phase files. Implementation ran on 2026-11-15 under the owner's instruction "all phases, no stopping, when you're done merge to develop and prune your tree(s)". That instruction continues past phase acceptance gates. It does not authorize a push, deployment, provider account, credential, DNS change or any other external action; those stay listed as pending.

- Worktree: `/Users/juan/code/retrofit-worktrees/url-to-preview`, branch `feat/url-to-preview`, from `develop` at `10d7eca`.
- Specification: `cognizant-ai-labs/agentic-web` at `63a956cf4653f610b1c238c70946f4d7647d17a8` (unchanged at Phase 1 entry, `git ls-remote` on 2026-11-15).
- Overlay: `.rpi/project/rpi-implement.md` is absent. No declared override applied.

## Deviations

| Phase | Plan said | Found | Chose | Why |
| --- | --- | --- | --- | --- |
| 1 | pnpm 10 | pnpm 12.15.0 is installed | `packageManager: pnpm@12.15.0` | Routine tool version; no plan behavior depends on pnpm 10. |
| 1 | Coverage summary at `.local/evidence/current/coverage-summary.json` | Vitest coverage cleans its report directory before each run, which would delete the other reports | Summary at `.local/evidence/current/coverage/coverage-summary.json` | Keeps the attempt's other reports intact. |
| 1 | Archy port edit after checking the Archy tree is clean | Archy's `develop` checkout has uncommitted operational reports | Separate Archy worktree on branch `chore/retrofit-ports` from `develop` (`6341360`) | Leaves the owner's uncommitted Archy changes untouched. |
| 1 | `next build` (implied: same tsconfig) | `next build` type-checks every file in `tsconfig.json`, including tests | `tsconfig.build.json` limited to `src/` for the build; `pnpm typecheck` still checks tests | Build failures stay about the application. |
| 1 | Vendored files pass the whitespace check | `generated/agent-runner.bundle.js` has trailing whitespace upstream | `.gitattributes` `-whitespace` for the three vendored roots | Vendored files stay unchanged; `vendor:verify` checks them instead. |
