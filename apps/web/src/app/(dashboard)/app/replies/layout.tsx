// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Replies",
  description:
    "Separate confirmed human responses, automated replies, unknown classifications, and subscriber matching before using inbound activity as engagement.",
};

export default function RepliesLayout({ children }: { children: ReactNode }) {
  return children;
}
