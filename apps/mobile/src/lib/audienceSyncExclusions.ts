/**
 * lib/audienceSyncExclusions.ts — who this sync would withhold, and the
 * receipt that proves it.
 *
 * TWO SURFACES OF THE ACTIVATION FIREWALL, both read-only, both about the same
 * question an operator cannot answer from a run row alone: the run says "12
 * withheld", and this says WHO and WHY.
 *
 *   GET /api/v1/audience-syncs/{id}/exclusion-preview  → SyncExclusionPreview
 *   GET /api/v1/audience-sync-runs/{run_id}/exclusion-receipt → text/csv
 *
 * FOUR SERVER FACTS THAT DECIDE EVERY SENTENCE HERE.
 *
 *  1. -1 MEANS "UNAVAILABLE", NOT ZERO. `unavailablePreview`
 *     (activation_firewall/sync_handlers.go:83-93) answers every count as -1
 *     when the member source could not be resolved (a ghost source, or the
 *     wire down). The handler's own comment says why: "so the honest-UI panel
 *     renders 'unavailable', never 0". Zero is a claim about the audience; this
 *     parser turns the sentinel into `null` so no screen can accidentally make
 *     that claim.
 *  2. THE PREVIEW IS ADVISORY AND COUNT-ONLY. It runs the firewall decision in
 *     count-only mode and writes no receipts (same file, header). It is a
 *     forecast for the NEXT run, not a record of the last one — the copy must
 *     never let it read as history.
 *  3. CONSENT AND POLICY COLLAPSE INTO ONE NUMBER. `excluded_consent` counts
 *     consent AND fail-deny policy exclusions together (handler comment:
 *     "both count as consent-driven from the operator's perspective"), while
 *     `excluded_suppression` is its own class. Reporting them as three separate
 *     causes would invent a distinction the server does not make.
 *  4. THE RECEIPT IS PER RUN, CARRIES EMAILS, AND IS ADMIN-ONLY. It is mounted
 *     `r.With(apikeys.RequireScope(apikeys.ScopeAdmin))` (sync_handlers.go:105)
 *     — and `ScopeAdmin` is neither in `readOnlyScopes` nor in
 *     `editorWriteScopes`, so on the session path `sessionRoleAllowsScopes`
 *     admits owner and admin only. The generated manifest disagrees
 *     (`session_minimum_role: "viewer"`, `policy_source: "safe-default:read"`,
 *     `review_status: "fail_closed_default"` — it never saw the guard), so the
 *     guard is what this app obeys: the stricter of the two, and the one that
 *     actually answers the request.
 *
 * No react-native import (csvShare is itself import-free), so all of it is
 * asserted by node tests.
 */
import { csvField, parseCsvRows } from "@/lib/csvShare";

/** A count the server marked unavailable is `null`, never 0 (fact 1). */
export interface SyncExclusionPreview {
  audienceCount: number | null;
  excludedConsent: number | null;
  excludedSuppression: number | null;
  excludedTotal: number | null;
  purpose: string;
  computedAt: string | null;
  /** True when the source could not be resolved at all — every count is null. */
  unavailable: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A finite non-negative count, or null. `-1` is the server's unavailable
 * sentinel; anything else non-numeric is a shape we did not get, which is also
 * "we do not know" rather than zero.
 */
function count(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  return Math.trunc(value);
}

export function parseSyncExclusionPreview(raw: unknown): SyncExclusionPreview {
  const body = record(raw);
  const audienceCount = count(body.audience_count);
  const excludedConsent = count(body.excluded_consent);
  const excludedSuppression = count(body.excluded_suppression);
  const excludedTotal = count(body.excluded_total);
  return {
    audienceCount,
    excludedConsent,
    excludedSuppression,
    excludedTotal,
    purpose: typeof body.purpose === "string" ? body.purpose : "",
    computedAt:
      typeof body.computed_at === "string" && body.computed_at.trim()
        ? body.computed_at
        : null,
    unavailable:
      audienceCount === null &&
      excludedConsent === null &&
      excludedSuppression === null &&
      excludedTotal === null,
  };
}

/**
 * The sentences the sheet renders. Facts 1-3 in order: an unavailable preview
 * says so instead of showing zeroes, the forecast is labelled as a forecast,
 * and the two exclusion classes are named as the server splits them.
 */
export function exclusionPreviewLines(
  preview: SyncExclusionPreview,
): string[] {
  const purpose = preview.purpose.trim();
  if (preview.unavailable) {
    return [
      "The server could not resolve this sync's source audience, so it cannot say who would be withheld. That is a gap in the answer, not an empty audience.",
      purpose ? `Consent purpose: ${purpose}.` : "",
    ].filter((line) => line !== "");
  }
  const show = (value: number | null) =>
    value === null ? "not reported" : String(value);
  const lines = [
    `${show(preview.audienceCount)} in the source audience right now`,
    `${show(preview.excludedConsent)} withheld for consent — no usable consent signal for this purpose`,
    `${show(preview.excludedSuppression)} withheld because they are suppressed`,
    `${show(preview.excludedTotal)} withheld in total, so the rest would be pushed`,
  ];
  if (purpose) lines.push(`Consent purpose: ${purpose}.`);
  lines.push(
    "This is a forecast for the next run, computed now and recorded nowhere — nothing was sent and no receipt was written.",
  );
  return lines;
}

/** Failure copy for the preview read. */
export function exclusionPreviewErrorMessage(error: unknown): string {
  const bag =
    error && typeof error === "object"
      ? (error as { status?: unknown; code?: unknown; message?: unknown })
      : {};
  const status = typeof bag.status === "number" ? bag.status : 0;
  if (status === 404) {
    return "That sync no longer exists, so there is nothing to preview.";
  }
  if (status === 403) {
    return "Your role cannot preview this sync's exclusions.";
  }
  if (status === 401) return "Your session expired. Sign in and try again.";
  if ("status" in bag && status === 0) {
    return "The preview never reached the server. Check your connection and try again.";
  }
  const message = typeof bag.message === "string" ? bag.message.trim() : "";
  return message || "The exclusion preview could not be loaded.";
}

/** Rows kept for the share sheet. The endpoint itself streams the whole run. */
export const EXCLUSION_RECEIPT_MAX_ROWS = 300;

/**
 * The server's columns, in the server's order (sync_handlers.go:186-190). All
 * seven are kept: unlike a submissions export, a receipt IS the evidence — the
 * rule that fired, the consent event it was decided against and the per-row
 * signature are the parts that make it one.
 */
const RECEIPT_COLUMNS = [
  "subscriber_email",
  "rule_class",
  "rule_reason",
  "purpose",
  "consent_event_id",
  "excluded_at",
  "signature",
] as const;

export interface ExclusionReceiptShare {
  body: string;
  title: string;
  included: number;
  truncated: boolean;
}

function isReceiptHeaderRow(row: readonly string[] | undefined): boolean {
  return (row?.[0] ?? "").trim().toLowerCase() === "subscriber_email";
}

/**
 * Bound and RE-EMIT the server's CSV before it reaches the share sheet, the
 * same treatment `formSubmissionsCsvShare` gives submissions and for the same
 * two reasons: `encoding/csv` does not neutralise a leading `=`, `+`, `-` or
 * `@`, and subscriber emails are attacker-suppliable; and a share sheet is not
 * a file, so a very large payload is mangled rather than delivered. A capped
 * receipt says so in its own title — a partial receipt passed off as complete
 * would be worse than none, because someone would file it as proof.
 */
export function exclusionReceiptShare(
  raw: string,
  {
    syncName,
    cap = EXCLUSION_RECEIPT_MAX_ROWS,
  }: { syncName: string; cap?: number },
): ExclusionReceiptShare {
  const parsed = parseCsvRows(raw ?? "").filter(
    (row) => row.length > 1 || (row[0] ?? "").trim() !== "",
  );
  const data =
    parsed.length > 0 && isReceiptHeaderRow(parsed[0])
      ? parsed.slice(1)
      : parsed;
  const limit = Math.max(0, Math.trunc(cap));
  const kept = data.slice(0, limit);
  // A response that fills the cap EXACTLY may be a slice with no way to tell
  // from here, so at-the-cap counts as truncated.
  const truncated =
    data.length > kept.length || (limit > 0 && data.length >= limit);

  const lines: string[] = [RECEIPT_COLUMNS.join(",")];
  for (const row of kept) {
    lines.push(
      RECEIPT_COLUMNS.map((_, index) => csvField(row[index] ?? "")).join(","),
    );
  }
  const name = syncName.trim() || "audience sync";
  return {
    body: lines.join("\n"),
    title: truncated
      ? `${name} — exclusion receipt (first ${kept.length} of more)`
      : `${name} — exclusion receipt (${kept.length} withheld)`,
    included: kept.length,
    truncated,
  };
}

/** Failure copy for the receipt download. */
export function exclusionReceiptErrorMessage(error: unknown): string {
  const bag =
    error && typeof error === "object"
      ? (error as { status?: unknown; message?: unknown })
      : {};
  const status = typeof bag.status === "number" ? bag.status : 0;
  if (status === 403) {
    // Fact 4: the guard is ScopeAdmin, and the rows carry subscriber emails.
    return "The exclusion receipt lists subscriber emails, so downloading it needs an admin role on this workspace.";
  }
  if (status === 404) return "That run's receipt is no longer available.";
  if (status === 401) return "Your session expired. Sign in and try again.";
  if ("status" in bag && status === 0) {
    return "The receipt never reached the server. Check your connection and try again.";
  }
  const message = typeof bag.message === "string" ? bag.message.trim() : "";
  return message || "The exclusion receipt could not be downloaded.";
}

export interface ReceiptCandidateRun {
  id: string;
  status: string;
  excludedCount: number | null;
  finishedAt: string | null;
}

/**
 * Which run's receipt the sheet offers, given the history it already holds.
 *
 * The newest run that WITHHELD anyone, rather than simply the newest: a receipt
 * for a run that excluded nobody is an empty CSV, and offering it as "the
 * receipt" teaches an operator that the firewall did nothing when in fact they
 * are looking at the wrong run. Runs arrive newest-first from the server
 * (`ListSyncRuns` orders by started_at DESC), and this preserves that order
 * rather than re-sorting on a timestamp that is null for a run still going.
 */
export function receiptRunForHistory(
  runs: readonly ReceiptCandidateRun[],
): ReceiptCandidateRun | null {
  for (const run of runs) {
    if ((run.excludedCount ?? 0) > 0) return run;
  }
  return null;
}
