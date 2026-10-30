// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Predictive",
  description:
    "Separate model readiness from data sufficiency before using lifetime value, RFM, or churn scores to target subscribers.",
};

export default function PredictiveLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
