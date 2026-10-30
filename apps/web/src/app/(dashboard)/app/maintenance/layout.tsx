// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Maintenance",
  description:
    "Run bounded workspace maintenance jobs, previews, and configuration checks.",
};

export default function MaintenanceLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
