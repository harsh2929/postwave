/**
 * mirror-summary — pure formatting for a mirror-run result. Lives in
 * a .ts module (not MirrorFromEspModal.tsx) so the node-environment
 * vitest suite can import it without a JSX transform.
 */

import type { SuppressionMirrorResult } from "../../lib/api-client";

/** One-line result summary: counts plus the provider window if reported. */
export function summarizeMirrorResult(r: SuppressionMirrorResult): string {
  const base = `Fetched ${r.fetched.toLocaleString()} · imported ${r.imported.toLocaleString()} · skipped ${r.skipped.toLocaleString()}${
    r.errors > 0
      ? ` · ${r.errors.toLocaleString()} error${r.errors === 1 ? "" : "s"}`
      : ""
  }`;
  if (r.window_from && r.window_to) {
    return `${base} (window ${r.window_from.slice(0, 10)} → ${r.window_to.slice(0, 10)})`;
  }
  return base;
}
