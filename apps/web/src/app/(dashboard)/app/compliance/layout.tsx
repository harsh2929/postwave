// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Compliance programmes" };

export default function ComplianceLayout({ children }: { children: ReactNode }) {
  return children;
}
