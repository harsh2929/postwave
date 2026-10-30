// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Notifications",
  description: "Review and manage workspace notification history.",
};

export default function NotificationsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
