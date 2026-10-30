// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Approval request",
  description: "Inspect and decide one governed workspace request.",
};

export default function ApprovalDetailLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
