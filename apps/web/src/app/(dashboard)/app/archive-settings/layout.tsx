// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Archive settings",
  description:
    "Review the public identity, campaign defaults, reader tipping, and custom-domain readiness of the newsletter archive.",
};

export default function ArchiveSettingsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
