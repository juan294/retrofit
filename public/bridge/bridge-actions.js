// Retrofit's shared actions for partner sites. A partner that calls retrofit_guide loads
// bridge/action-bridge.html in a hidden frame on Retrofit's origin; the bridge registers
// these actions and shares each one with the callers its callerOrigins lists
// (runtime/action-transport.js). build_network.mjs names this module in
// bridge/agent-manifest.json because the file exists.
//
// score_site is shared with every origin: a score describes a public website, and the
// request runs from this frame against Retrofit's own /api/score, under the same server limits
// per visitor and per site as on Retrofit's page. The runtime opens a new frame for each partner
// call, so the action waits for a running score within one call (pollInCall) instead of
// keeping state between calls.

import { scoreSiteAction } from "../site-actions.js";

const HOME = new URL("../", import.meta.url).href;

/**
 * Register the actions that Retrofit shares with partner sites.
 *
 * :param actions: The runtime registry facade with a register(definition) method.
 */
export function registerActions(actions) {
  const unexpectedReason = `Retrofit returned an answer that score_site could not read. Do not give a score. Tell the user to score the site at ${HOME} instead.`;
  actions.register({ ...scoreSiteAction({ unexpectedReason, pollInCall: true }), availability: "bridge", callerOrigins: ["*"] });
}
