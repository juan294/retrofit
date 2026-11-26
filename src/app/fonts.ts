import localFont from "next/font/local";

// The two families of the Field Inspection design, served from Retrofit's own origin (the page policy has
// font-src 'self'). The files come from the pinned @fontsource packages (OFL-1.1), so nothing is fetched at build time.

/**
 * Archivo as one variable face: weight 100 to 900 and width 62% to 125%. Body text uses the normal width;
 * display headings use `font-stretch: 62%`. Without the width range in the face, a browser draws 62% as normal width.
 */
export const archivo = localFont({
  src: "../../node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--fi-font-archivo",
  declarations: [{ prop: "font-stretch", value: "62% 125%" }],
});

/**
 * IBM Plex Mono for labels, fields and code: the three weights the design uses. No generated fallback face:
 * that face is a resized Arial, and a missing mono file must fall back to a system mono (the list is in globals.css).
 */
export const plexMono = localFont({
  src: [
    { path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  display: "swap",
  variable: "--fi-font-plex",
  adjustFontFallback: false,
  // Three files, and most pages use one or two of them: each loads when a text first needs it.
  preload: false,
});
