# Phase 3: done-for-you contact, SES alias and release inputs

Parent plan: [2026-11-22-retrofit-bundle-and-done-for-you.md](../2026-11-22-retrofit-bundle-and-done-for-you.md).

## Entry conditions

- Phase 2 accepted (or continuation authorized). Rebase on current `develop`.
- Step 1 below needs Juan's authorization for that exact AWS change.

## Steps

1. External, authorized separately: add `retrofit@thecreativetoken.com` as a recipient that forwards the same way as `juan@thecreativetoken.com`. First read the rule `juan-tct-forward` and its Lambda configuration (read only) to learn whether forwarding maps each recipient to a destination. Show the exact change before applying it. After it, send one test email and confirm it arrives (manual check 2). If forwarding cannot be extended without changing the Lambda code, stop and report; the fallback is `juan@thecreativetoken.com`, which needs Juan's decision.
2. `src/lib/site/own-site.ts` (`LEAD_EMAIL` exists since Phase 1): a `leadMailto(host, score)` helper that percent-encodes the subject `Retrofit install for <host> (score <n>)`, and a second JSON-LD `Service` "Done-for-you agentic website setup" with `provider` and a `contactPoint` email. `llms.txt` gains one line under a "Contact" heading.
3. `InstallPanel.tsx`: the done-for-you line with `leadMailto`. Home page (`src/app/page.tsx`): one sentence after the form, "We can also set it up for you: retrofit@thecreativetoken.com", as a `mailto:` link.
4. `docs/decisions/2026-11-22-bundle-without-claim.md`: the owner decision that the analysis owner downloads the bundle without a claim; it narrows the brief's "a claim unlocks the install" (brief line 56) and the matching `AGENTS.md` sentence to Retrofit-hosted publishing. Update that `AGENTS.md` sentence in the same commit.
5. Release inputs: `CHANGELOG.md` "Unreleased" entry; `.rpi/release-profile.json` current gaps empty or listing anything still open; `tools/release/required-tests.json` complete; the notes file handoff. The release itself (merge to `main`, push, deployment, production evidence, tag) follows `docs/release/release-playbook.md` and needs Juan's authorization for each external step.

## Tests

- `tests/site/own-site.test.ts`: `leadMailto` encodes `&`, spaces, `#` and non-ASCII hosts (punycode form); JSON-LD validates as JSON and names the address.
- `e2e/own-site.spec.ts` and `e2e/bundle-install.spec.ts`: the link text and `href` on the home and results pages; the score in the subject equals the page's score.
- Phone width and theme tests pass with the line present.

## Exit criteria

- Parent success criterion 7 passes in full; manual checks 1 to 3 recorded.
- Full gate, analyzer ACCEPTED. Review, repair, simplify, handoff. Stop for acceptance; the release is a separate authorized workflow.
