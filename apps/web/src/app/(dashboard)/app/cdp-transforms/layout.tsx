// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "CDP transform preview",
  description:
    "Dry-run registered CDP property transforms against bounded sample JSON without applying or persisting them.",
};

export default function CDPTransformsLayout({ children }: { children: ReactNode }) {
  return children;
}
