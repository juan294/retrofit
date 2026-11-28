import type { MetadataRoute } from "next";
import { BRAND_COLOURS } from "@/lib/site/brand";

/**
 * The web app manifest (/manifest.webmanifest). Icons come from tools/brand/build-icons.mjs. Retrofit is a
 * website, so an installed copy opens in the normal browser window, with its address bar for sign-in and checkout.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Retrofit",
    short_name: "Retrofit",
    description: "Turn an existing website into an agentic website without a rebuild.",
    start_url: "/",
    display: "browser",
    background_color: BRAND_COLOURS.paper,
    theme_color: BRAND_COLOURS.paper,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
