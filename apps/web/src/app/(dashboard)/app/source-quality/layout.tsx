// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { PATHNAME_HEADER } from "@/lib/safe-navigation";

// Keep one route segment for this small page family. A second metadata-only
// layout emitted another client bootstrap request for Gift history even though
// it rendered no markup. Middleware already forwards the normalized pathname,
// so the parent can retain the precise document title without another layout
// boundary or another request in the initial route graph.
export async function generateMetadata(): Promise<Metadata> {
  const pathname = (await headers()).get(PATHNAME_HEADER);
  return {
    title: pathname?.startsWith("/app/source-quality/gifts")
      ? "Gift history"
      : "Source quality",
  };
}

export default function SourceQualityLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
