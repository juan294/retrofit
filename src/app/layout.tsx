import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { BRAND_COLOURS } from "@/lib/site/brand";
import { archivo, plexMono } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Retrofit",
  description: "Turn an existing website into an agentic website without a rebuild.",
};

// The browser's toolbar takes the Field Inspection paper colour. The icons come from src/app/icon.svg,
// favicon.ico and apple-icon.png (tools/brand/build-icons.mjs) and the manifest from manifest.ts.
export const viewport: Viewport = {
  themeColor: BRAND_COLOURS.paper,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page, including not-found and error pages, renders per request so it carries the nonce.
  await connection();
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}>
      <body className="fi-shell">{children}</body>
    </html>
  );
}
