// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Service suite & Helpdesk",
  description:
    "Inspect stored service-suite configuration and administer tenant-bound Helpdesk records.",
};

export default function ServiceSuiteLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
