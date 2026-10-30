// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * One page shell for a dashboard route: consistent max width, padding, and
 * centering. Replaces the four divergent wrappers across the subscribers
 * cluster (`p-8 max-w-6xl`, `max-w-5xl p-4 md:p-8`, `p-6 max-w-4xl`, …) so the
 * cluster reads as one product instead of four hand-tuned pages.
 */
export function PageShell({
  children,
  className,
  tourTarget,
}: {
  children: React.ReactNode;
  className?: string;
  tourTarget?: string;
}) {
  return (
    <div
      data-slot="page-shell"
      data-tour={tourTarget}
      className={cn(
        "mx-auto min-w-0 w-full max-w-6xl space-y-6 px-4 py-5 sm:px-6 sm:py-7 md:p-8",
        className,
      )}
    >
      {children}
    </div>
  );
}
