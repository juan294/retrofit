import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { archivo, plexMono } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Retrofit",
  description: "Turn an existing website into an agentic website without a rebuild.",
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
