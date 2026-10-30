// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Scoring and tags",
  description:
    "Understand the weights moving subscriber scores, the taxonomy describing your audience, and the subscription and attribution rules around it.",
};

export default function ScoringLayout({ children }: { children: ReactNode }) {
  return children;
}
