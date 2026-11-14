# Retrofit: design brief

> Created 2026-11-14 from the Archy conversation of 2026-11-13 and 2026-11-14. This is the accepted starting point for the product plan. Each claim is marked VERIFIED (read in that session, source named) or INFERRED.

## Purpose

Retrofit takes the URL of any public website and gives its owner a working AI agent for that site, without a rebuild. The site keeps its pages. The agent is a set of files on the owner's own site that runs in the visitor's browser.

The intent in the owner's words: agentify the website to modernize it, unlock new business for the merchant and make the site easier to use for the customer.

Retrofit is the entry for the Open Agentic Web Challenge. It must also bring consulting leads to Juan through a "we do it for you" offer.

## Hackathon facts

Source: the Devpost overview page, the official rules page and the `cognizant-ai-labs/agentic-web` repository, read on 2026-11-13. VERIFIED unless marked.

- Event: Open Agentic Web Challenge, https://cognizant-agenticweb.devpost.com/. Sponsor Cognizant. Partners: Cognizant AI Lab, Mozilla (Otari), MIT NANDA, AWS, UT Austin, AI Commons.
- Submission period: 2026-11-11 8:00 pm PT to 2027-01-11 8:00 am PT (5:00 pm in Spain). Judging 2027-01-11 to 2027-01-18. Winners about 2027-01-19.
- Prizes: $5,000, $3,000 and $2,000, plus Otari credits. No tracks.
- Required build: "a working open agentic website built with standard open web technologies that conforms to the open agentic web specification" as of the start of the submission period.
- Required parts: a public URL with a conforming `.json` that describes an agent network, a `runtime` that runs the network in the browser, and an interface for users or agents. An interface to configure LLMs and keys is optional. The network should interact with the site, and optionally with other agentic sites, or be callable by them.
- Submission: a video under 2 minutes on YouTube with the entrant explaining (the overview says "not AI generated"), no third-party trademarks in the video, a text description and screenshots. If Otari is used, the account email and one sentence of feedback.
- The project must be "free of charge and without any restriction" for judges until judging ends.
- Judging: Stage 1 is pass or fail on conformance. Stage 2 has four equal criteria: Technological Implementation (first tie-breaker), Design, Potential Impact (includes tools shared with the community) and Quality of the Idea.
- Open source: the overview says "Everything you build is open source, so the best ideas become part of the foundation everyone builds on next." The Discord announcement says "Any LLM works, as long as your project is open source". The rules page does not mention open source. The license, the repository requirement and the scope for server-side code are not stated in the pages read. The rules say that ambiguous terms need a written clarification request.
- Intellectual property stays with the entrant. Spain is not on the exclusion list (INFERRED eligible).
- Existing projects are allowed only if "significantly updated" after the start. Retrofit is new, so this does not apply.

## Specification facts

Source: `docs/worldwide_agentic_web_mvp_spec.md` and `docs/providers/providers.md` in `cognizant-ai-labs/agentic-web` (Apache-2.0, last push 2026-11-13). The README warns that content changes often. The full specification was not read end to end.

- The site publishes `agent-manifest.json`, with `allowed_peers` and `peer_policy` for calls between sites.
- Bring-your-own-key is optional: "A runtime can conform without offering BYOK when the published default inference path runs the network". A default router paid by the publisher is allowed.
- When BYOK is offered, the user "MUST be able to select or enter the permitted router base URL, model, and credential". The key stays in the browser and MUST NOT be in URLs or manifests. The user MUST be able to delete stored profiles.
- BYOK "does not isolate the credential from other JavaScript executing on the caller origin".
- Consent is required before the runtime contacts a third-party origin.
- A peer network runs in the visitor's browser and gets none of the partner site's own functions.
- Published instructions "MUST NOT be treated as a confidentiality mechanism".
- The runtime uses OpenAI Chat Completions (`POST <router>/chat/completions`, `GET <router>/models`). The provider must allow browser CORS. OpenAI, OpenRouter and Otari work. Anthropic is conditional.
- The repository has a skill `skills/agentify-website/SKILL.md` (needs Node.js 22) and examples `guesthouse_agentified`, `harbor_tours_agentified` and a pizza restaurant. Its "Testing" section says the validation script is TODO. The runtime folder has its own `LICENSE.txt`, which was not read.

## Accepted product design

### Flow

1. Score. A visitor pastes any public URL. Retrofit reads the site and scores how ready it is for agents. The score is deterministic and uses no LLM. Agents can call it as a tool.
2. Preview. Retrofit builds a live agent grounded in that site and runs it in the browser. The preview is private and labelled unofficial.
3. Plan. Retrofit gives the steps to make the site agentic.
4. Bundle. Retrofit gives the files that the owner installs on the site.
5. Hire. A "we do it for you" contact goes to Juan.

### Access rules

- Anyone can paste any URL. There is no ownership check for the private preview (owner decision).
- An owner claims a site with a meta tag or a DNS record. A claim unlocks official publishing, the badge and the install.
- Retrofit follows robots rules, caches results and limits requests per site.
- A server-side fetch service reads third-party sites, because browsers block cross-origin reads.

### Usage tiers

- 5 free analyses.
- After that, the visitor signs up and uses their own LLM key, or pays. The key stays in the browser and never reaches Retrofit servers. Fetches stay limited per account. Marketing consent is an unticked checkbox.
- Payment by Stripe starts after judging ends on 2027-01-18. During the hackathon there is a pricing page with "notify me". Judges need free access without restriction.
- The paid tier sells bulk API use, saved reports and publishing for claimed sites. Agencies can use it to find prospects.

### Key entry panel

The owner called key pasting "terrible UX and insecure". The panel must reduce both problems.

- One paste field. Retrofit detects the provider from the key format (patterns not yet verified), tests the key at once and shows "Connected to X".
- The panel appears only when a key is needed.
- Links go directly to the provider page that creates a key. Plain words. An "Advanced" link shows router URL, model and credential, which the specification requires.
- Clear errors. Markup that password managers recognise.
- The key is kept for the session only by default, with a "Forget my key" control. Show a cost estimate and suggest a limited key.
- Host the panel and runtime on a separate subdomain with no third-party scripts.
- Offer a "built-in AI, no key" choice where the browser supports it.

Options that were examined and rejected: Sign in with ChatGPT (limited partner trial, needs a confidential client for websites), OpenRouter OAuth (works in the browser, rejected because it forces visitors to create an OpenRouter account). Options still open: the on-device Chrome Prompt API (desktop Chrome 148 or later, tool calling not confirmed, no mobile) and a capped default paid by Retrofit (estimate 1 to 3 cents per plan, not measured).

### Hosting

The owner decided to host under `thecreativetoken.com`, so the product needs no domain of its own. The expected address is `retrofit.thecreativetoken.com`. Nothing is configured.

## Positioning

Lead line: an agent on your own website that can take the order, and it is yours to keep.

Differences from the readiness checkers:

1. The agent is files on the owner's own site and runs in the visitor's browser. No vendor and no subscription.
2. The agent acts (cart, booking) with the visitor's confirmation. It does more than answer questions.
3. It serves people and other agents. Sites can call each other.
4. A done-for-you service is available.

Competitors read on 2026-11-13 (VERIFIED from their own pages):

- `agentready.it.com`: "Your site, agent-ready in 60 seconds". Hosted MCP endpoint, cited answers, grade, badge, meta-tag ownership, Free, $49 and $149 plans, read-only, "not another chatbot".
- Cloudflare `isitagentready.com`: about 22 checks in five categories, ends with instructions for a coding agent.
- `agentready.dev`: Markdown audit, 7 checks, a waitlist for an "Agent Layer".
- `erold90/AgentReady`: WebMCP scanner, BSL 1.1.
- Hostinger "web2agent" was found and not read.

None of these mention the open agentic web specification.

Originality is the weakest judging criterion for this idea, because scoring and "ready in one minute" already exist. The demo must show the agent acting and two sites calling each other.

## Name

The owner chose **Retrofit** on 2026-11-14: the trade word for upgrading an existing building without rebuilding it. Slug `retrofit`.

Owner decision, 2026-11-14: because the product is published under a `thecreativetoken.com` subdomain, domain availability does not limit the name, and Retrofit stays. No trademark search or product search was done. Retrofit is also the name of a well-known open-source HTTP client for Android and Java from Square (INFERRED from memory, not checked in this session); that is a developer library, a different kind of product. The hackathon video must not show third-party trademarks.

## Open questions for the plan

- Stack, package manager, test tools and hosting provider.
- Which license the organizers expect and whether server-side code must be open. A clarification request needs the owner's approval and agreed wording.
- How the acting agent reaches cart and booking functions on a site that Retrofit does not control.
- Key-format detection patterns for each provider.
- Whether the Chrome Prompt API supports tool calling.
- Limits and abuse controls for the fetch service.
- Law for outreach and marketing consent.
- The Devpost submission form was not seen.
- The `agentify-website` skill from the organizers was not run.
