// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Lifecycle",
  description:
    "See where subscribers sit in the funnel, which sources are growing it, and whether goals and mailbox-provider quality support the same story.",
};

export default function LifecycleLayout({ children }: { children: ReactNode }) {
  return children;
}
