// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Alerting and access",
  description:
    "Verify incident-provider credentials and manage short-lived workspace access secrets.",
};

export default function AlertingAccessLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
