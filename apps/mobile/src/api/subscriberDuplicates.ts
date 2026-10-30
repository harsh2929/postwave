/**
 * api/subscriberDuplicates.ts — the duplicate-review queue's four calls.
 *
 * AUTHORIZATION, READ OFF BOTH GUARDS. Two independent middlewares run on
 * every route below and a session must clear BOTH; reading either one alone
 * gets this surface wrong in opposite directions.
 *
 *  READS — `GET /api/v1/subscribers/duplicates` and
 *  `GET /api/v1/subscribers/duplicate-scans/{scanID}/pairs`
 *    per-route  `apikeys.RequireScope(ScopeReadReports)`
 *               (subscriber_dedupe/subscriber_dedupe.go:34-39). `read:reports`
 *               is in the `readOnlyScopes` allowlist
 *               (apikeys/middleware.go:332-337), so on the session path
 *               `requireAdminRoleForScopes` is false and any role passes.
 *    routeauth  manifest.json rows carry `"session_minimum_role": "viewer"`,
 *               `"api_key_scopes": ["read:subscribers"]`,
 *               `"policy_source": "family:subscribers"`,
 *               `"review_status": "reviewed"`.
 *    NET        viewer. An API key needs read:reports AND read:subscribers.
 *
 *  MERGE — `POST /api/v1/merge/apply`
 *    per-route  `apikeys.RequireScope(ScopeWriteSubscribers)`
 *               (merge/handlers.go:39-40). On the session path `write:
 *               subscribers` is an `editorWriteScopes` member, so RequireScope
 *               alone would admit an EDITOR (apikeys/middleware.go:300-318).
 *    routeauth  the manifest row is `"session_minimum_role": "admin"`,
 *               `"api_key_scopes": ["admin"]`,
 *               `"policy_source": "route-contract.authorization+safe-default:admin"`.
 *               `roleAllows` (routeauth/middleware.go:94-112) is a strict rank
 *               compare with no custom-role escape hatch.
 *    NET        owner/admin ONLY. The stricter guard decides, so an editor who
 *               can see the queue still cannot merge from it, and the screen
 *               must say that rather than render a button that 403s.
 *
 * THE READ THAT IS ALSO A WRITE. `GET /api/v1/subscribers/duplicates` is not a
 * cheap list: `List` calls `createCompleteScan` (scan.go:109-131), which opens
 * a REPEATABLE READ transaction, takes a per-tenant advisory lock and
 * materializes a complete manifest over every subscriber before returning page
 * one. That is why this module names it `startDuplicateScan`, why the hook
 * that calls it never auto-retries, and why pull-to-refresh means "scan
 * again", not "re-read". A second concurrent scan answers 409
 * `duplicate_scan_in_progress` (scan.go:117-119).
 *
 * ONE ROUTE DELIBERATELY NOT CALLED. `GET /api/v1/subscribers/duplicate-scans/
 * {scanID}` returns the scan envelope on its own — but every pairs page already
 * embeds the same `Scan` struct (scan.go:388-394), so polling it would be a
 * second round trip for bytes the device already has. There is no route that
 * LISTS past scans; `duplicate-scans` is POST-only in `MountRoutes`
 * (subscriber_dedupe.go:37), so a "pick a previous scan" picker has nothing to
 * read and is not offered.
 */
import {
  normalizeDuplicateMergePlan,
  type DuplicateMergePlan,
} from "@/lib/duplicateMergePlan";
import {
  normalizeDuplicateScanPage,
  type DuplicateScanPage,
} from "@/lib/duplicateScan";

import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

/**
 * How many candidate pairs one page reads.
 *
 * `parsePageLimit` (scan.go:196-208) defaults to 50 and caps at 200. 25 is a
 * deliberate reduction: this is a review queue worked one decision at a time,
 * and every row past the first screenful is a row paid for over cellular that
 * nobody has looked at yet.
 */
export const DUPLICATE_PAIRS_PAGE_SIZE = 25;

/** Keeps status AND the server's error code so the UI can tell 409s apart. */
export class DuplicateRequestError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "DuplicateRequestError";
  }
}

async function duplicateRequest<T>(
  method: string,
  path: string,
  label: string,
  body?: unknown,
): Promise<T | null> {
  const res = await rawRequest<T>(method, path, body);
  if (res.error) throw new DuplicateRequestError(res.error, label);
  return res.data;
}

/**
 * True for "your role cannot do this" from either guard.
 *
 * routeauth writes `insufficient_role` and RequireScope writes
 * `insufficient_scope`; both arrive as 403 and mean the same thing to a
 * reader, so the status alone is the honest test.
 */
export function isDuplicateRoleDenied(error: unknown): boolean {
  return (
    error instanceof DuplicateRequestError
      ? error.status === 403
      : typeof error === "object" &&
        error !== null &&
        (error as { status?: unknown }).status === 403
  );
}

/** True for the 409 a second concurrent scan gets (scan.go:117-119). */
export function isDuplicateScanBusy(error: unknown): boolean {
  const status =
    error instanceof DuplicateRequestError
      ? error.status
      : typeof error === "object" && error !== null
        ? Number((error as { status?: unknown }).status ?? 0)
        : 0;
  const code =
    error instanceof DuplicateRequestError
      ? error.code
      : typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
  return status === 409 && code === "duplicate_scan_in_progress";
}

/**
 * Materialize a complete manifest and read its first page.
 *
 * Returns `{scan, pairs, count, next_cursor, complete}` — the same envelope the
 * pairs route returns, so both feed one parser.
 */
export async function startDuplicateScan(
  limit: number = DUPLICATE_PAIRS_PAGE_SIZE,
): Promise<DuplicateScanPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  const raw = await duplicateRequest<unknown>(
    "GET",
    `/api/v1/subscribers/duplicates?${params.toString()}`,
    "Scanning for duplicates",
  );
  return normalizeDuplicateScanPage(raw);
}

/** One more page of an already-materialized manifest. */
export async function listDuplicatePairs(
  scanId: string,
  cursor: string,
  limit: number = DUPLICATE_PAIRS_PAGE_SIZE,
): Promise<DuplicateScanPage> {
  const id = (scanId ?? "").trim();
  if (!id) throw new Error("A scan id is required to read duplicate pairs.");
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  const raw = await duplicateRequest<unknown>(
    "GET",
    `/api/v1/subscribers/duplicate-scans/${encodeURIComponent(id)}/pairs?${params.toString()}`,
    "Loading duplicate pairs",
  );
  return normalizeDuplicateScanPage(raw);
}

export interface DuplicateMergeRequest {
  scanId: string;
  /** The record that SURVIVES. The caller chooses; the server does not. */
  survivorId: string;
  /** The record that is closed. */
  loserId: string;
  /** The scan's own instants — `apply` compares them to the frozen manifest. */
  survivorUpdatedAt: string;
  loserUpdatedAt: string;
}

function applyBody(
  input: DuplicateMergeRequest,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    primary_id: input.survivorId,
    duplicate_id: input.loserId,
    scan_id: input.scanId,
    expected_primary_updated_at: input.survivorUpdatedAt,
    expected_duplicate_updated_at: input.loserUpdatedAt,
    ...extra,
  };
}

/**
 * Compute the exact plan WITHOUT writing.
 *
 * `dry_run: true` returns before any statement runs and the deferred rollback
 * discards the transaction (apply.go:339-342), so this is safe to issue the
 * moment a pair is opened. It is what makes the confirmation specific.
 */
export async function previewDuplicateMerge(
  input: DuplicateMergeRequest,
): Promise<DuplicateMergePlan | null> {
  const raw = await duplicateRequest<unknown>(
    "POST",
    "/api/v1/merge/apply",
    "Computing the merge plan",
    applyBody(input, { dry_run: true }),
  );
  return normalizeDuplicateMergePlan(raw);
}

/**
 * Execute the plan the operator was shown.
 *
 * `expected_plan_fingerprint` is REQUIRED for a real apply (apply.go:223-226)
 * and is compared in constant time (apply.go:343). Replaying the fingerprint is
 * what makes "apply" provably the same operation as the preview rather than a
 * fresh computation over data that may have moved.
 */
export async function applyDuplicateMerge(
  input: DuplicateMergeRequest & { planFingerprint: string },
): Promise<DuplicateMergePlan | null> {
  const raw = await duplicateRequest<unknown>(
    "POST",
    "/api/v1/merge/apply",
    "Merging the records",
    applyBody(input, {
      dry_run: false,
      expected_plan_fingerprint: input.planFingerprint,
    }),
  );
  return normalizeDuplicateMergePlan(raw);
}
