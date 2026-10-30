// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Reviews",
  description:
    "Review the public privacy contract, moderation vocabulary, and every published review surface for the workspace.",
};

export default function ReviewsLayout({ children }: { children: ReactNode }) {
  return children;
}
