// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Suppressions" };

export default function SuppressionsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
