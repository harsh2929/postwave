// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Browser magic link",
  robots: { index: false, follow: false, nocache: true },
};

export default function BrowserMagicLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
