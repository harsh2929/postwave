// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Data hygiene" };

export default function DataHygieneLayout({ children }: { children: ReactNode }) {
  return children;
}
