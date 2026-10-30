// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Cohorts",
  description:
    "Compare intake-month engagement, distinguish human activity from machine noise, and spot send fatigue before it becomes churn.",
};

export default function CohortsLayout({ children }: { children: ReactNode }) {
  return children;
}
