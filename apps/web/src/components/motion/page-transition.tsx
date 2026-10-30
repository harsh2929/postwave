// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Subtle page-arrival motion for dashboard routes. Keyed on pathname so the
 * content re-mounts and replays its enter transition on every navigation — a
 * small upward fade that makes route changes feel deliberate rather than
 * instantaneous.
 *
 * Amplitude is intentionally tiny (8px) versus the marketing site's 24px
 * scroll reveals: in-product motion should read as responsive, not theatrical.
 * The content area has no `position: sticky`/non-portaled `fixed` descendants
 * (overlays are Radix portals at the body), so the brief wrapper transform is
 * safe. prefers-reduced-motion collapses to a position-stable instant fade.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // The flow canvas fills the shell's remaining space, including when the
  // sample-data notice changes its height. A viewport estimate cropped its
  // toolbar whenever focusing a control scrolled the oversized editor.
  const fillsWorkspace =
    pathname?.startsWith("/app/flows/") &&
    pathname !== "/app/flows/configuration";
  return (
    <div
      key={pathname}
      data-slot="page-transition"
      className={`pw-page-transition min-h-full min-w-0${fillsWorkspace ? " h-full" : ""}`}
    >
      {children}
    </div>
  );
}
