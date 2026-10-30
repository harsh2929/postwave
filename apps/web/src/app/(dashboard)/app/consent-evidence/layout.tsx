// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Consent evidence" };

export default function ConsentEvidenceLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
