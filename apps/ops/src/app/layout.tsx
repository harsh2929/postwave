// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

import AppBar from "@/components/AppBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Moosewave Ops",
  description:
    "Platform-operator board — six lanes, staleness derived at read time.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <AppBar />
        {children}
      </body>
    </html>
  );
}
