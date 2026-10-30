// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Signup protection",
  description:
    "Review signup-firewall decisions, automatic protection posture, protected segments, and planned service windows.",
};

export default function SignupProtectionLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
