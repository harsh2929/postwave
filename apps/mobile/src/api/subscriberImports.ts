/**
 * api/subscriberImports.ts — transport for the subscriber IMPORT job surface.
 *
 * Every route below was read off the chi mount in
 * `apps/api/internal/subscriber_import/subscriber_import.go::MountRoutes`
 * (mounted from `internal/server/operator_reference_routes.go:38`), not from
 * openapi.json and not from routeauth/manifest.json:
 *
 *   GET  /api/v1/subscriber-imports              → {imports,has_more,next_cursor}
 *   GET  /api/v1/subscriber-imports/{id}         → one job + its preflight state
 *   POST /api/v1/subscriber-imports/{id}/confirm → 202 {id,status:"queued",…}
 *   POST /api/v1/subscriber-imports/{id}/cancel  → 202 {id,status,cancel_requested}
 *
 * ─── THE AUTHORIZATION IS NOT WHAT THE GENERATED MANIFEST SAYS ───
 *
 * `routeauth/manifest.json` records `GET /api/v1/subscriber-imports` as
 * `session_minimum_role: "viewer"` with `api_key_scopes: ["read:subscribers"]`,
 * and it even marks the row `"review_status": "reviewed"`. That is WRONG in the
 * permissive direction. `MountRoutes` opens with
 *
 *     admin := apikeys.RequireScope(apikeys.ScopeAdmin)
 *
 * and wraps EVERY route in it — the list read included. Tracing that gate:
 * `ScopeAdmin` is not in `readOnlyScopes` (middleware.go:332, which holds only
 * read:subscribers / read:campaigns / read:reports / audit:read), so
 * `requireAdminRoleForScopes` is true, so the session path falls through to
 * `sessionRoleAllowsScopes`, where only `isAdminOrOwner` passes — `editor` is
 * admitted for `editorWriteScopes` (write:subscribers / write:campaigns) only,
 * which does not include `admin`.
 *
 * Verified by running the real middleware rather than by reading it:
 *   session viewer/member/editor → 403 insufficient_role
 *   session admin/owner          → through
 *   api key read:subscribers or write:subscribers → 403 insufficient_scope
 *   api key admin                → through
 *
 * So this whole surface — reads included — is owner|admin, and the mobile
 * screen gates on that. A screen built to the manifest would have shipped a
 * list that can only ever render a 403 for four of the five roles.
 *
 * ─── /{id}/progress IS SERVER-SENT EVENTS, NOT A JSON POLL ───
 *
 * `Deps.Progress` (subscriber_import.go:1186) sets
 * `Content-Type: text/event-stream`, writes `event: progress` frames on a 1s
 * ticker and holds the connection open for up to `progressMaxDuration` (30
 * minutes) while the job runs. A plain `fetch` of it against a RUNNING job does
 * not return a body — it hangs until the job finishes or the half-hour cap
 * expires. It is therefore deliberately NOT wired here: the phone polls
 * `GET /{id}` instead, which returns the same six progress counters
 * (`status`, `processed_rows`, `rows_total`, `rows_imported`, `rows_skipped`,
 * `rows_failed` — compare `readProgress`'s SELECT at subscriber_import.go:1273)
 * plus the preflight state the Confirm gate needs, in one bounded request.
 *
 * ─── NO UPLOAD ───
 *
 * `POST /preview` is multipart CSV. Picking a file, reviewing a 100-row sample,
 * remapping columns and running an exhaustive preflight is a desktop job, and a
 * half-built version of it on a phone would strand rows in `preview` that the
 * phone then cannot confirm. The header says so instead.
 *
 * Parsing lives in lib/subscriberImportJobs so it is unit-testable in the node
 * vitest environment; this module is only URLs and envelopes.
 */
import {
  parseImportJobDetail,
  parseImportJobPage,
  type SubscriberImportJobDetail,
  type SubscriberImportPage,
} from "@/lib/subscriberImportJobs";

import { checkedApiResult, rawRequest } from "./request";

export const SUBSCRIBER_IMPORTS_PATH = "/api/v1/subscriber-imports";

/** `Deps.List` rejects a limit outside 1..200 with 400 invalid_limit. */
export const SUBSCRIBER_IMPORT_PAGE_SIZE = 50;

export function subscriberImportPath(id: string): string {
  return `${SUBSCRIBER_IMPORTS_PATH}/${encodeURIComponent(id)}`;
}

export function subscriberImportListPath(cursor?: string | null): string {
  const query = new URLSearchParams({
    limit: String(SUBSCRIBER_IMPORT_PAGE_SIZE),
  });
  if (cursor) query.set("cursor", cursor);
  return `${SUBSCRIBER_IMPORTS_PATH}?${query.toString()}`;
}

export async function fetchSubscriberImports(
  cursor?: string | null,
): Promise<SubscriberImportPage> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", subscriberImportListPath(cursor)),
  );
  return parseImportJobPage(res.data);
}

/**
 * One job. Throws when the payload has no `id` — the caller must not be handed
 * a half-parsed job whose every counter reads as "unknown", because on this
 * screen an unknown counter is a legitimate rendering and would hide the drift.
 */
export async function fetchSubscriberImport(
  id: string,
): Promise<SubscriberImportJobDetail> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", subscriberImportPath(id)),
  );
  const job = parseImportJobDetail(res.data);
  if (!job) {
    throw new Error("The server returned an import job this app cannot read.");
  }
  return job;
}

/**
 * Confirm. The body is optional server-side and an empty one is tolerated
 * (`AllowEmptyBody`), but `{dry_run: false}` is sent EXPLICITLY: omitting the
 * field and sending `{dry_run: true}` are two different handlers
 * (`Confirm` vs `d.dryRun`), and being explicit means a future default flip
 * cannot silently turn a real import into a validation-only pass — or worse,
 * the reverse.
 */
export async function confirmSubscriberImport(id: string): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>("POST", `${subscriberImportPath(id)}/confirm`, {
      dry_run: false,
    }),
  );
}

/**
 * Cancel. No body: `Deps.Cancel` reads none, and the flag it sets is
 * idempotent — a second press on an already-cancelling job answers 409
 * `not_cancellable` only once the row has actually left queued/running.
 */
export async function cancelSubscriberImport(id: string): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>("POST", `${subscriberImportPath(id)}/cancel`),
  );
}
