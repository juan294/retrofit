/**
 * The Field Inspection colours that leave the stylesheet: the browser reads the theme colour and the web app
 * manifest before any CSS. Each value equals its token in src/app/globals.css (tests/brand/icons.test.ts checks
 * it); the icon files carry the same ink and accent (tools/brand/build-icons.mjs).
 */
export const BRAND_COLOURS = {
  /** --fi-paper: the page background, used for the toolbar and the install splash. */
  paper: "#f0f1f0",
} as const;
