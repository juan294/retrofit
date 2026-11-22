// Retrofit's own site action: score_site, the grounded capability of retrofit_guide.
// agent-manifest.json loads this module through "actions.module"; the runtime calls its
// registerActions export, and the model sees the action as website_score_site.
// Contract: docs/research/score-tool-contract.md, Surface 2. The handler never throws for
// an expected outcome: a throw becomes status "unknown", which tells the model never to
// retry. Every answer is {ok, status, report | error, reason, field?, retryAfterSeconds?}.

const MAX_URL = 2048;
const SPACING_MS = 20_000;
const REQUEST_TIMEOUT_MS = 35_000;
const MAX_RUNNING = 6;
// A partner's call through the bridge ends after 180 s (runtime/action-transport.js); polling inside
// one call stops before a further wait and request could pass this budget.
const BRIDGE_POLL_BUDGET_MS = 140_000;

const DESCRIPTION =
  "Gets Retrofit's agent-readiness score (0 to 100, score/v1) for a public website, with each check's result, rule and evidence. Pass the address as the user gave it; Retrofit scores the site from its home page, so a path is not used. Results are kept for 24 hours. A call can take up to a minute. If the result says the score is still running, call again with the same URL. Read-only: it changes nothing on this page or on the scored site.";

const RUNNING_REASON = "The score is still running. Call score_site again in 20 seconds with the same URL.";
const STOP_REASON = "The score is still running after several checks. Tell the user to try again in a few minutes.";

// API error code -> the HTTP status it comes with, and the text the model gets.
// "timed" texts need retryAt and retryAfterSeconds from the API body.
const ERRORS = {
  missing_url: {
    status: 400,
    field: "url",
    reason: () => "No website address was given. Ask the user for the address of the site to score, then call score_site with it.",
  },
  invalid_url: {
    status: 400,
    field: "url",
    reason: () => "That is not a website address. Ask the user for the site's address, such as example.com, then call score_site again.",
  },
  not_public: {
    status: 400,
    field: "url",
    reason: () =>
      "This address is not a public website. Retrofit scores only public sites, not IP addresses, local names or private networks, and the name must exist. Ask the user to check the spelling or give another address. Do not guess a corrected address.",
  },
  robots_blocked: {
    status: 422,
    reason: () =>
      "This site asks automated tools not to read it. Retrofit stopped and read nothing else. Tell the user that the site owner can allow RetrofitBot in robots.txt. Do not call score_site again for this site.",
  },
  robots_unavailable: {
    status: 503,
    timed: true,
    reason: (t) => `Retrofit could not read this site's robots rules, so it stopped. Tell the user to try again after ${t.time} UTC (in ${t.minutes} minutes).`,
  },
  crawl_error: {
    status: 502,
    reason: () =>
      "Retrofit could not read this site. It did not answer in time, redirected too many times or refused the connection. Ask the user to check that the address opens in a browser. If the site works only over http, call score_site once with an address that starts with http://.",
  },
  stale: {
    status: 503,
    reason: () => "This score took too long. Call score_site again now with the same URL to start a new one.",
  },
  queue_expired: {
    status: 503,
    reason: () => "Retrofit is too busy right now. Tell the user to try again in a few minutes.",
  },
  client_limit: {
    status: 429,
    timed: true,
    reason: (t) => `This browser reached the limit of 20 site scores per hour. Tell the user they can score another site after ${t.time} UTC (in ${t.minutes} minutes).`,
  },
  daily_limit: {
    status: 429,
    reason: () => "Retrofit reached today's analysis limit. Tell the user to try again tomorrow (after 00:00 UTC).",
  },
  unavailable: {
    status: 503,
    reason: () => "Retrofit is having trouble. Tell the user to try again in a few minutes.",
  },
};

const NETWORK_REASON = "Retrofit's score service did not answer. Call score_site again once with the same URL. If it fails again, tell the user to try later.";
const UNEXPECTED_REASON =
  "Retrofit returned an answer that score_site could not read. Do not give a score. Tell the user to paste the address in the form at the top of this page instead.";

const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function fail(code, reason, extra = {}) {
  return { ok: false, status: "error", error: code, reason, ...extra };
}

const unexpected = () => fail("unexpected_response", UNEXPECTED_REASON);
const network = () => fail("network", NETWORK_REASON);

function isReport(body) {
  return (
    plain(body) &&
    body.scoreVersion === "score/v1" &&
    Array.isArray(body.checks) &&
    body.checks.length === 16 &&
    (body.score === null || Number.isInteger(body.score))
  );
}

/** retryAt as HH:MM UTC and retryAfterSeconds as whole minutes, or null when either is unusable. */
function retryTime(body) {
  const at = typeof body.retryAt === "string" ? new Date(body.retryAt) : null;
  const seconds = body.retryAfterSeconds;
  if (!at || Number.isNaN(at.getTime()) || !Number.isInteger(seconds) || seconds < 0) return null;
  return { time: at.toISOString().slice(11, 16), minutes: Math.ceil(seconds / 60) };
}

/** Map one API answer (HTTP status and parsed JSON body) to the action result. */
function mapAnswer(status, body) {
  if (status === 200) return isReport(body) && body.status === "ready" ? { ok: true, status: "ready", report: body } : unexpected();
  if (status === 202) return plain(body) && body.status === "running" ? { ok: false, status: "running" } : unexpected();
  if (!plain(body) || typeof body.error !== "string" || !hasOwn(ERRORS, body.error)) return unexpected();
  const spec = ERRORS[body.error];
  if (spec.status !== status) return unexpected();
  let reason;
  if (spec.timed) {
    const t = retryTime(body);
    if (!t) return unexpected();
    reason = spec.reason(t);
  } else {
    reason = spec.reason();
  }
  const extra = {};
  if (spec.field) extra.field = spec.field;
  if (Number.isInteger(body.retryAfterSeconds) && body.retryAfterSeconds >= 0) extra.retryAfterSeconds = body.retryAfterSeconds;
  return fail(body.error, reason, extra);
}

/** Resolve after ms, or false as soon as signal aborts. */
function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** GET /api/score on this page's origin, aborted at 35 s or with the runtime's signal. */
async function requestScore(url, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(onAbort, REQUEST_TIMEOUT_MS);
  try {
    let response;
    let text;
    try {
      response = await fetch("/api/score?url=" + encodeURIComponent(url), {
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
      });
      text = await response.text();
    } catch {
      return network();
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return unexpected();
    }
    return mapAnswer(response.status, body);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Build the score_site action. On Retrofit's page, its state (the last running answer and
 * the count of consecutive running answers for each URL) lasts as long as this registration,
 * that is the page session of the assistant that registered it.
 *
 * :param options: unexpectedReason replaces the reason for an unreadable answer, because a
 *   partner's visitor is not on Retrofit's page and has no Retrofit form to paste into.
 *   pollInCall makes one call wait and ask again while the score runs, up to MAX_RUNNING
 *   answers or BRIDGE_POLL_BUDGET_MS. The action bridge (bridge/bridge-actions.js) sets both:
 *   the runtime opens a new bridge frame for each partner call, so state between calls is lost.
 */
export function scoreSiteAction({ unexpectedReason, pollInCall = false } = {}) {
  const runs = new Map();

  async function ask(url, signal) {
    const result = await requestScore(url, signal);
    if (unexpectedReason && result.error === "unexpected_response") result.reason = unexpectedReason;
    return result;
  }

  async function pollScore(url, signal) {
    const start = Date.now();
    for (let count = 1; ; count++) {
      const result = await ask(url, signal);
      if (result.status !== "running") return result;
      const out = count >= MAX_RUNNING || Date.now() - start + SPACING_MS + REQUEST_TIMEOUT_MS > BRIDGE_POLL_BUDGET_MS;
      if (out) return { ok: false, status: "running", reason: STOP_REASON };
      if (!(await wait(SPACING_MS, signal))) return network();
    }
  }

  async function execute(args, context) {
    const url = plain(args) && typeof args.url === "string" ? args.url.trim() : "";
    if (!url) return fail("missing_url", ERRORS.missing_url.reason(), { field: "url" });
    if (url.length > MAX_URL) return fail("invalid_url", ERRORS.invalid_url.reason(), { field: "url" });

    const signal = context?.signal;
    const last = runs.get(url);
    if (last) {
      const delay = last.at + SPACING_MS - Date.now();
      if (delay > 0 && !(await wait(delay, signal))) return network();
    }

    if (pollInCall) return pollScore(url, signal);
    const result = await ask(url, signal);
    if (result.status !== "running") {
      runs.delete(url);
      return result;
    }
    const count = (last?.count ?? 0) + 1;
    runs.set(url, { at: Date.now(), count });
    if (count >= MAX_RUNNING) return { ok: false, status: "running", reason: STOP_REASON };
    return { ok: false, status: "running", retryAfterSeconds: 20, reason: RUNNING_REASON };
  }

  return {
    name: "score_site",
    description: DESCRIPTION,
    effect: "read",
    timeoutMs: 60_000,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "The website address the user gave, such as example.com or https://example.com/menu. If the user gave no address, ask for it. Never guess one.",
        },
      },
    },
    execute,
  };
}

/**
 * Register Retrofit's actions with the agent runtime.
 *
 * :param actions: The runtime registry facade with a register(definition) method.
 */
export function registerActions(actions) {
  actions.register(scoreSiteAction());
}
