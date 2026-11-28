// The fixed names of an ownership claim, with no dependencies, so page copy (also bundled for the
// browser) can show them.

/** `<meta name="retrofit-site-verification" content="<token>">` in the home page head. */
export const CLAIM_META_NAME = "retrofit-site-verification";
/** The TXT record `_retrofit-verification.<host name>` holds `retrofit-site-verification=<token>`. */
export const CLAIM_TXT_LABEL = "_retrofit-verification";
export const CLAIM_TXT_PREFIX = "retrofit-site-verification=";
