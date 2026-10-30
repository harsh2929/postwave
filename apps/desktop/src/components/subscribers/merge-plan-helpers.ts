/**
 * merge-plan-helpers — pure logic for the merge dry-run / apply flow
 * (R14: POST /api/v1/merge/apply, apps/api/internal/merge/apply.go).
 *
 * The endpoint computes a MergePlan (tags union, custom-field merge,
 * status, consent timestamp, gdpr permissions) and either returns it
 * with dry_run:true (zero-move counters, nothing written) or executes
 * it verbatim. The loser row is SOFT-deleted (disabled + marked
 * merged_into), never hard-deleted — copy in the UI must say so.
 *
 * 409 `already_merged` means the duplicate row was the loser of a
 * previous merge; the only honest action is to drop the stale pair
 * and rescan.
 */

import type { MergeApplyResponse, MergePlan } from "../../lib/api-client";
import type { ApiResult } from "../../lib/api-client";

export interface PlanRow {
  label: string;
  value: string;
}

function fmtUnknown(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v || "—";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Flatten the plan into label/value rows, rendered verbatim — no
 * client-side re-derivation of what the server said it will write.
 */
export function buildPlanRows(plan: MergePlan): PlanRow[] {
  const rows: PlanRow[] = [];
  rows.push({
    label: "Tags (union)",
    value: plan.tags.length > 0 ? plan.tags.join(", ") : "(none)",
  });
  const fieldKeys = Object.keys(plan.custom_fields);
  if (fieldKeys.length === 0) {
    rows.push({ label: "Custom fields", value: "(none)" });
  } else {
    for (const k of fieldKeys.sort()) {
      rows.push({
        label: `Field · ${k}`,
        value: fmtUnknown(plan.custom_fields[k]),
      });
    }
  }
  rows.push({ label: "Status", value: plan.status || "—" });
  rows.push({
    label: "Consent timestamp",
    value: plan.consent_timestamp ?? "(none recorded)",
  });
  rows.push({
    label: "GDPR permissions",
    value:
      plan.gdpr_permissions.length > 0
        ? plan.gdpr_permissions.map((entry) => fmtUnknown(entry)).join(" · ")
        : "(none)",
  });
  return rows;
}

/** events/suppressions counters from a dry-run response are always
 * zero (nothing moved). Label them honestly. */
export function moveCountersCopy(resp: MergeApplyResponse): string {
  if (resp.dry_run) {
    return "Events + suppressions move on apply — the dry run writes nothing, so the server reports 0 moved until then.";
  }
  return `${resp.events_moved.toLocaleString()} event${resp.events_moved === 1 ? "" : "s"} and ${resp.suppressions_moved.toLocaleString()} suppression${resp.suppressions_moved === 1 ? "" : "s"} moved to the primary.`;
}

export interface MergeResultCopy {
  message: string;
  detail: string;
}

/** Toast copy for a real (non-dry-run) apply — server counters verbatim. */
export function mergeResultCopy(
  resp: MergeApplyResponse,
  _primaryEmail: string,
  _duplicateEmail: string,
): MergeResultCopy {
  return {
    message: "Subscriber rows merged",
    detail:
      moveCountersCopy(resp) +
      (resp.loser_soft_deleted
        ? " The duplicate row was soft-deleted (disabled), not erased."
        : " The server did NOT report the duplicate as soft-deleted — check the row."),
  };
}

/** True when the apply failed because the duplicate was already the
 * loser of a previous merge (409 already_merged). */
export function isAlreadyMerged(result: ApiResult<unknown>): boolean {
  // A bare 409 is ambiguous: stale_review and candidate_stale use the same
  // status. Only the server's typed code proves the merge already landed.
  return result.error?.code === "already_merged";
}
