// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Approvals",
  description:
    "Inspect approval requests and record release-qualified rejection decisions.",
};

export default function ApprovalsLayout({ children }: { children: ReactNode }) {
  return children;
}
