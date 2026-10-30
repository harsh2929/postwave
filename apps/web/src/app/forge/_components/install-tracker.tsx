// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, type ReactNode } from "react";

import { track } from "@/lib/telemetry";

/**
 * Wraps the install-command card and emits `mcp_install_clicked` when
 * the user clicks the card / copy button. Intentionally captures
 * pointer-anywhere-on-the-card so the existing visual treatment (a
 * single card with a tiny "copy" affordance) doesn't need any layout
 * changes.
 *
 * No PII is captured: the command itself is a public install snippet
 * baked into the page source.
 */
export function InstallTracker({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  // Also emit one impression event so we can compute click-through
  // rate without requiring a separate page-view filter.
  useEffect(() => {
    track("mcp_install_impression");
  }, []);

  return (
    <div
      onClick={() => track("mcp_install_clicked")}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") track("mcp_install_clicked");
      }}
      role="presentation"
    >
      {children}
    </div>
  );
}
