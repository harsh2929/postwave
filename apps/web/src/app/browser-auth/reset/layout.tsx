// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Browser password reset",
  robots: { index: false, follow: false, nocache: true },
};

export default function BrowserResetLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
