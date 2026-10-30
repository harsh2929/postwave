// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Pilot readiness",
  description:
    "Review scoped migration, sending, consent, and rollback evidence for a limited pilot.",
};

export default function PilotReadinessLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
