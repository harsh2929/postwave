// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Routing",
  description:
    "See where inbound email arrives, which rules handle it, and which workspace events are delivered to external systems.",
};

export default function RoutingLayout({ children }: { children: ReactNode }) {
  return children;
}
