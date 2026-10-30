/**
 * lib/duplicateMergePlan.ts — the server's exact merge plan, and the sentence
 * a person has to agree to before it runs.
 *
 * WHICH MERGE ROUTE THIS IS FOR, AND WHY NOT THE OTHER ONE. There are two:
 *
 *   POST /api/v1/subscribers/merge  (subscribers/merge.go:104)
 *       Needs `primary_version` AND `duplicate_version` — strong subscriber
 *       revisions — and answers 428 when either is missing (merge.go:126-129).
 *       The duplicate scan does not carry revisions, so a phone would have to
 *       fetch both subscriber records first, opening a race between the read
 *       and the write on the very rows it is about to destroy.
 *
 *   POST /api/v1/merge/apply        (merge/apply.go:181)
 *       Binds to `scan_id` plus the two `updated_at` instants THE SCAN ALREADY
 *       RETURNED (apply.go:269-299), which is exactly what this screen has in
 *       hand. It also answers a dry run with the exact plan and a fingerprint
 *       the real apply must replay (apply.go:339-345), so the confirmation can
 *       state what will happen instead of describing merges in general.
 *
 * So this surface uses `/api/v1/merge/apply`, and the cost is a stricter gate:
 * see `api/subscriberDuplicates.ts` for both authorization layers.
 *
 * WHAT THE PLAN ACTUALLY DOES (apply.go:325-405, verified line by line — the
 * confirmation copy below is derived from this and nothing else):
 *   survivor  tags unioned · custom_fields unioned with the survivor's keys
 *             winning · status set to the STRICTEST of the two · consent set
 *             to the EARLIER timestamp · GDPR permissions most-restrictive
 *   moved     every `subscriber_events` row, plus `suppressions` and
 *             `email_suppressions`, re-pointed from the loser's address to the
 *             survivor's — this does not move back
 *   loser     SOFT-deleted, not deleted: status becomes `disabled`, a
 *             `pw:merged` tag is added and `merged_into` / `merged_at` are
 *             written into custom_fields (apply.go:391-404). The row and its
 *             address survive for audit.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

export interface DuplicateMergeConflict {
  field: string;
  /** "primary_wins" | "most_restrictive_wins" | a value we do not know yet. */
  resolution: string;
  survivorValue: string;
  duplicateValue: string;
}

export interface DuplicateMergePlan {
  primaryId: string;
  duplicateId: string;
  dryRun: boolean;
  tags: string[];
  status: string;
  consentTimestamp: string;
  conflicts: DuplicateMergeConflict[];
  preserved: string[];
  customFieldCount: number | null;
  gdprPermissionCount: number | null;
  /** Absent measurements stay null; a dry run legitimately reports 0. */
  eventsMoved: number | null;
  suppressionsMoved: number | null;
  loserSoftDeleted: boolean;
  primaryUpdatedAt: string;
  duplicateUpdatedAt: string;
  planFingerprint: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => str(entry)).filter((entry) => entry !== "");
}

/**
 * A conflict value is `any` on the wire (apply.go:86-87) — whatever sits in a
 * custom field. Scalars are shown; a structured value is NAMED rather than
 * JSON-dumped into a 390pt row, because an unreadable blob in a destructive
 * confirmation is worse than an honest "this is an object".
 */
export function conflictValueLabel(value: unknown): string {
  if (value === null || value === undefined) return "not set";
  if (typeof value === "string") return value.trim() === "" ? "empty" : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return value.length === 1 ? "a 1-item list" : `a ${value.length}-item list`;
  }
  return "a structured value";
}

/**
 * The server's shape, read off the producer rather than off a consumer:
 * `mergePlanFingerprint` returns `fmt.Sprintf("sha256:%x", digest[:])` over a
 * 32-byte SHA-256 (apply.go:480-493), i.e. exactly 64 LOWERCASE hex digits.
 */
const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/u;

export function isUsablePlanFingerprint(value: string): boolean {
  return FINGERPRINT_RE.test(value);
}

export function normalizeDuplicateMergePlan(
  raw: unknown,
): DuplicateMergePlan | null {
  const row = record(raw);
  const primaryId = str(row.primary_id);
  const duplicateId = str(row.duplicate_id);
  if (!primaryId || !duplicateId) return null;
  const plan = record(row.plan);
  const customFields = record(plan.custom_fields);
  const gdpr = Array.isArray(plan.gdpr_permissions)
    ? plan.gdpr_permissions.length
    : null;
  const conflicts = Array.isArray(plan.conflicts)
    ? plan.conflicts.map((entry) => {
        const conflict = record(entry);
        return {
          field: str(conflict.field),
          resolution: str(conflict.resolution),
          survivorValue: conflictValueLabel(conflict.primary_value),
          duplicateValue: conflictValueLabel(conflict.duplicate_value),
        };
      })
    : [];
  return {
    primaryId,
    duplicateId,
    dryRun: row.dry_run === true,
    tags: stringList(plan.tags),
    status: str(plan.status),
    consentTimestamp: str(plan.consent_timestamp),
    conflicts: conflicts.filter((conflict) => conflict.field !== ""),
    preserved: stringList(plan.preserved_on_duplicate),
    customFieldCount:
      plan.custom_fields === undefined || plan.custom_fields === null
        ? null
        : Object.keys(customFields).length,
    gdprPermissionCount: gdpr,
    eventsMoved: intOrNull(row.events_moved),
    suppressionsMoved: intOrNull(row.suppressions_moved),
    loserSoftDeleted: row.loser_soft_deleted === true,
    primaryUpdatedAt: str(row.primary_updated_at),
    duplicateUpdatedAt: str(row.duplicate_updated_at),
    planFingerprint: str(row.plan_fingerprint),
  };
}

/**
 * A dry run that cannot be replayed is not a plan.
 *
 * `apply` compares the fingerprint with `subtle.ConstantTimeCompare`
 * (apply.go:343) and answers 409 on a mismatch, so a preview whose fingerprint
 * is missing or malformed can only ever lead to a refused merge. Offering the
 * button anyway would be offering a dead control.
 */
export function planIsApplyable(plan: DuplicateMergePlan | null): boolean {
  return Boolean(
    plan &&
      plan.dryRun &&
      isUsablePlanFingerprint(plan.planFingerprint) &&
      plan.primaryUpdatedAt !== "" &&
      plan.duplicateUpdatedAt !== "",
  );
}

export interface MergeConfirmCopy {
  title: string;
  message: string;
  consequence: string;
  confirmLabel: string;
}

/**
 * The confirmation, built from THIS pair and THIS plan.
 *
 * It names the survivor and the loser by address in both directions, because
 * "Merge these two?" is the version of this dialog that gets people merged the
 * wrong way round. It also states the two things a reader would otherwise have
 * to assume: that the loser is closed rather than erased, and that the moved
 * history does not move back.
 *
 * NO TYPED-PHRASE GATE, deliberately. `ConfirmSheet` supports one, and it is
 * right for "wipe this workspace" — but this is a REVIEW QUEUE, and a queue
 * that makes you type an email address per item is a queue nobody clears, so
 * the friction would push the work back to a desk instead of adding safety.
 * The escalation here is stronger and specific: the server's own plan for this
 * exact pair has to load and be shown before the button exists at all.
 */
export function mergeConfirmCopy(input: {
  survivorEmail: string;
  loserEmail: string;
  plan: DuplicateMergePlan | null;
}): MergeConfirmCopy {
  const survivor = input.survivorEmail || "the surviving record";
  const loser = input.loserEmail || "the duplicate record";
  const plan = input.plan;
  const parts = [`${survivor} survives and keeps its address and id.`];
  parts.push(
    `${loser} is closed: its status becomes disabled, it is tagged pw:merged, and it is marked as merged into ${survivor}. The row is kept for audit, not deleted.`,
  );
  parts.push(
    `Every event, suppression and consent record on ${loser} moves to ${survivor} and does not move back.`,
  );
  if (plan && plan.status) {
    parts.push(`The merged record ends up ${plan.status}.`);
  }
  if (plan && plan.conflicts.length > 0) {
    parts.push(
      plan.conflicts.length === 1
        ? "1 field disagrees and is resolved in the plan above."
        : `${plan.conflicts.length} fields disagree and are resolved in the plan above.`,
    );
  }
  return {
    title: "Merge these two records?",
    message: `Only ${survivor} will be reachable afterwards.`,
    consequence: parts.join(" "),
    confirmLabel: "Merge",
  };
}

/**
 * The human sentence for a failed preview or apply, by what the server said.
 *
 * Every branch below is a real, reachable answer from `Apply`
 * (apply.go:215-241) or from one of the two guards in front of it. A generic
 * "something went wrong" here would hide the one thing the operator can act on
 * — most of these are fixed by re-running the scan, and one is not.
 */
export function mergeErrorMessage(error: unknown): string {
  const row = record(error);
  const status = typeof row.status === "number" ? row.status : 0;
  const code = str(row.code);
  if (code === "already_merged") {
    return "This duplicate was already merged into another record, so its history has moved somewhere else. Re-run the scan.";
  }
  if (code === "stale_review") {
    return "One of these records changed while you were reviewing. Nothing was merged — re-run the scan and review the new plan.";
  }
  if (code === "candidate_stale") {
    return "This pair is no longer part of the reviewed scan. Nothing was merged — re-run the scan.";
  }
  if (code === "review_required" || status === 428) {
    return "The server needs a reviewed plan for this exact pair. Re-run the scan and open the pair again.";
  }
  if (code === "merge_unavailable" || status === 503) {
    return "The merge service is not available on this deployment right now. Nothing was merged.";
  }
  if (status === 403) {
    return "Merging needs an owner or admin session. Nothing was merged.";
  }
  if (status === 409) {
    return "The records changed since the scan ran. Nothing was merged — re-run the scan.";
  }
  if (status === 404) {
    return "One of these records no longer exists. Nothing was merged — re-run the scan.";
  }
  if (status === 0) {
    return "The merge could not be sent. Nothing was merged — check your connection and try again.";
  }
  const message = str(row.message);
  return message
    ? `Nothing was merged: ${message}`
    : "Nothing was merged. Re-run the scan and try again.";
}

/** The toast after a merge that landed. States only what the server returned. */
export function mergeSuccessMessage(
  survivorEmail: string,
  plan: DuplicateMergePlan | null,
): string {
  const survivor = survivorEmail || "the surviving record";
  const moved = plan?.eventsMoved;
  if (moved === null || moved === undefined) {
    return `Merged into ${survivor}.`;
  }
  return moved === 1
    ? `Merged into ${survivor}. 1 event moved.`
    : `Merged into ${survivor}. ${moved} events moved.`;
}
