/**
 * portal-dashboard-helpers — pure derivations for the Privacy Portal KPI
 * dashboard.
 *
 * Kept out of the component so the empty / partial-body shapes are
 * unit-testable. The portal endpoint can return a 200 with a minimal body
 * on a brand-new workspace (array fields omitted entirely), so every
 * derivation here must tolerate `undefined` inputs and never throw — a
 * throw white-screens the whole portal instead of rendering an honest
 * empty state.
 */

import type { PrivacyPortalSummary } from "../../lib/api-client";

export interface DsarTotals {
  open: number;
  overdue: number;
  closed: number;
}

/**
 * Sum open / overdue / closed across every DSAR request type.
 *
 * Defensive on two axes: the array itself may be undefined (partial body),
 * and individual rows may omit their numeric fields. Both default to 0 so
 * the reduce never reads `.open` off undefined and never produces NaN.
 */
export function dsarTotals(
  rows: PrivacyPortalSummary["dsar_requests"] | undefined,
): DsarTotals {
  return (rows ?? []).reduce<DsarTotals>(
    (acc, r) => ({
      open: acc.open + (r.open ?? 0),
      overdue: acc.overdue + (r.overdue ?? 0),
      closed: acc.closed + (r.closed ?? 0),
    }),
    { open: 0, overdue: 0, closed: 0 },
  );
}
