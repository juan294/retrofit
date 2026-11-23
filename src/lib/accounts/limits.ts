// Account limits with no dependencies, so page copy (also bundled for the browser) can name them.

/** The most saved reports one account keeps (and the account page lists). */
export const MAX_SAVED_REPORTS = 100;

/** The most pending ownership claims one account holds (create and Start over refuse past it). */
export const MAX_PENDING_CLAIMS = 10;
/** Consecutive failed checks that lapse a verified claim. */
export const CLAIM_LAPSE_AFTER = 3;
/** Checks (Check again and Start over) of one claim per hour. The daily recheck does not count. */
export const CLAIM_CHECKS_PER_HOUR = 5;
/** Claim creations and Start overs of one account per hour. */
export const CLAIM_CHANGES_PER_HOUR = 20;
/** A verified or lapsed claim is rechecked once its last check is this old. */
export const CLAIM_RECHECK_AFTER_S = 24 * 3600;
/** A claim lapsed longer than this is rechecked only weekly (CLAIM_SLOW_RECHECK_AFTER_S). */
export const CLAIM_SLOW_AFTER_S = 30 * 24 * 3600;
export const CLAIM_SLOW_RECHECK_AFTER_S = 7 * 24 * 3600;
/** Publishes and refreshes of one account per hour (Unpublish, and a refresh without a newer read, do not count). */
export const PUBLISH_PER_HOUR = 10;
/** Every try of one account per hour, also those without a newer read: each one reads the account's analyses. */
export const PUBLISH_TRIES_PER_HOUR = 60;
