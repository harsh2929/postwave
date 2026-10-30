// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Win-back",
  description:
    "Owners and admins can review stored churn-scoring settings, offer rows, and aggregate counters; this evidence does not prove enrollment, delivery, acceptance, or coupon application.",
};

export default function RetentionLayout({ children }: { children: ReactNode }) {
  return children;
}
