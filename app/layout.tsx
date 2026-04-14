// This file defines the one shared page shell for the whole app.
// Every route in the app is rendered inside this HTML structure.

// Next.js reads this type so the metadata object uses the right shape.
// The global stylesheet is loaded here so it applies to every page in the app.
import type { Metadata } from "next";
import "./globals.css";

// This metadata becomes the default title and description for the app.
// Browsers and search engines use this information for the site tab and previews.
export const metadata: Metadata = {
  title: "Airtable Cache Service",
  description: "Persistent Airtable cache and preload proxy.",
};

// RootLayout is the top-level wrapper around every page in the app.
// It must return the basic HTML document elements that Next.js expects.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
