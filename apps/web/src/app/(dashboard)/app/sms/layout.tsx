// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "SMS",
  description:
    "Consent-first SMS operations, campaign preparation, registration, inbox evidence, and release-held outbound controls.",
};

export default function SmsLayout({ children }: { children: ReactNode }) {
  return children;
}
