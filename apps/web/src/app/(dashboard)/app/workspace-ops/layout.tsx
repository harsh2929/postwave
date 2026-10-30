// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Workspace operations",
  description:
    "Inspect retention, deliverability, warm-up, engagement, template, and feature-flag evidence.",
};

export default function WorkspaceOperationsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
