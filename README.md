# Retrofit

Retrofit turns an existing website into an agentic website without a rebuild.

Paste a public URL. Retrofit scores how ready the site is for AI agents, builds a working agent for that site that runs in the browser, and gives the plan and the files to install it. The agent is files on your own site. It can answer and it can act, with the visitor's confirmation.

Retrofit is built for the [Open Agentic Web Challenge](https://cognizant-agenticweb.devpost.com/) and follows the open agentic web specification in [cognizant-ai-labs/agentic-web](https://github.com/cognizant-ai-labs/agentic-web).

## Status

Workspace setup only. There is no application code yet. See the [briefing](docs/briefing.md) and the [design brief](docs/research/2026-11-14-retrofit-brief.md).

## Development

Shared project instructions are in [AGENTS.md](AGENTS.md). The project uses the Research-Plan-Implement workflow from [cc-rpi](https://github.com/juan294/cc-rpi). The integration branch is `develop`. The production branch is `main`.

Run the setup checks from the repository root:

```sh
python3 .rpi/scripts/rpi-verify.py
```

## License

Apache-2.0. See [LICENSE](LICENSE).
