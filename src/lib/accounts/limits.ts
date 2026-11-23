// Account limits with no dependencies, so page copy (also bundled for the browser) can name them.

/** The most saved reports one account keeps (and the account page lists). */
export const MAX_SAVED_REPORTS = 100;

/** The most pending ownership claims one account holds (create and Start over refuse past it). */
export const MAX_PENDING_CLAIMS = 10;
/** Consecutive failed checks that lapse a verified claim. */
export const CLAIM_LAPSE_AFTER = 3;
/** Checks (Check again and Start over) of one claim per hour. The daily recheck does not count. */
export const CLAIM_CHECKS_PER_HOUR = 5;
