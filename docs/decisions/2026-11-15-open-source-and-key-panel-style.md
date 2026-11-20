# Open source scope and key panel style

Owner decisions, 2026-11-15.

## Open source scope

The whole project is open source under Apache-2.0, including server-side code. The repository may become public for the hackathon. The owner can review this scope after the hackathon.

Effect:

- The question to the organizers about which license they expect and whether server-side code must be open is no longer needed. It was never sent.
- The plan does not need to separate open client code from closed server code.
- Juan authorized the change to public separately, and the repository became public on 2026-11-15 at `develop` commit `c5dac9b`.
- A change back to private later does not remove content that was public. Forks, clones and caches can keep it. Do not commit anything that must stay private.

Evidence before the change: on 2026-11-15, `gitleaks git` scanned all 9 commits and found no leaks. No ignored local path (`.local/`, `.rpi/local/`, `docs/agents/`, `graphify-out`) or transcript file appears in the history.

## Key panel style

The key entry panel uses a new neutral style for now. The owner's existing design systems (Chapa, Coach Anvil "Bedrock", Portfolio) are not used. The owner can review this choice later.
