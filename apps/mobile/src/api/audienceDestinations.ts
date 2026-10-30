/**
 * api/audienceDestinations.ts — transport for audience destinations.
 *
 * Parsing and the status vocabulary live in `lib/audienceDestinationRows.ts`
 * and `lib/audienceDestinationActions.ts`, both react-native-free so node-run
 * vitest can cover them. This file is only the calls, and it deliberately
 * exposes no create and no `config` edit — see the rows module's header for
 * why the split falls there.
 *
 * SYNC-NOW (2026-08 parity row): `POST /{id}/sync` is
 * `RequireScope(ScopeWriteSubscribers)` (handlers.go:68-69) — editor floor on
 * the session path, the same floor as running an audience SYNC — and answers
 * 202 on every terminal path with the outcome in `status`. It honors
 * `Idempotency-Key` (`manualOperationKey`), so the key is minted per press and
 * a transport retry converges on one server-side operation instead of a second
 * delivery. PREVIEW and JOB DIAGNOSTICS are both `ScopeReadReports`
 * (handlers.go:72-79) — viewer-floored reads.
 */
import { rawRequest } from "@/api/request";
import {
  parseDestinationPreview,
  parseJobDiagnostics,
  parseSyncNowResult,
  type DestinationPreview,
  type DestinationSyncNowResult,
  type JobDiagnostics,
} from "@/lib/audienceDestinationActions";
import {
  parseDestinations,
  parseSyncJobs,
  type AudienceDestination,
  type DestinationStatus,
  type DestinationSyncJob,
} from "@/lib/audienceDestinationRows";

const BASE = "/api/v1/audience-destinations";

/**
 * UNWRAP BEFORE PARSING. `rawRequest` resolves to the `AIApiResult` ENVELOPE
 * (`{data, error}` — api/request.ts:79-81), never to the response body. Both
 * reads below used to hand that envelope straight to a parser that looks for
 * `.items` on the object it is given, so the lookup landed on the envelope,
 * missed, and returned `[]` for EVERY well-formed response.
 *
 * That is the worst shape of bug for these two screens: a permanently empty
 * list and a permanently empty run history, both failing SILENTLY and both
 * indistinguishable from "this workspace has no destinations yet". It also
 * defeated the parser-level `items`-vs-`jobs` fix directly below in
 * lib/audienceDestinationRows.ts, which was correct but could never be reached.
 *
 * A parser-only test cannot catch this class — the seam is the transport. The
 * tests that pin it drive these functions with `rawRequest` mocked.
 */
async function readList<T>(
  path: string,
  parse: (raw: unknown) => T[],
  label: string,
): Promise<T[]> {
  const res = await rawRequest<unknown>("GET", path);
  // Surfaced, not swallowed: a failed read must reach the error state rather
  // than render as an empty one.
  if (res.error) throw Object.assign(new Error(res.error.message || label), res.error);
  return parse(res.data);
}

export async function fetchDestinations(): Promise<AudienceDestination[]> {
  return readList(BASE, parseDestinations, "Couldn't load destinations.");
}

export async function fetchDestinationJobs(
  id: string,
): Promise<DestinationSyncJob[]> {
  return readList(
    `${BASE}/${encodeURIComponent(id)}/jobs`,
    parseSyncJobs,
    "Couldn't load the run history.",
  );
}

/** PATCH {status}. The only mutation shape mobile sends. */
export async function setDestinationStatus(
  id: string,
  status: Extract<DestinationStatus, "active" | "paused">,
): Promise<void> {
  await rawRequest<unknown>("PATCH", `${BASE}/${encodeURIComponent(id)}`, {
    status,
  });
}

export async function disconnectDestination(id: string): Promise<void> {
  await rawRequest<unknown>("DELETE", `${BASE}/${encodeURIComponent(id)}`);
}

/**
 * POST /{id}/sync — push the destination's audience now.
 *
 * The promise resolving means "the server answered", never "it delivered":
 * the handler is 202 on success, failure, cap rejection and replay alike, and
 * the outcome lives in the returned status (see lib/audienceDestinationActions).
 * A rejected envelope (403, 503 runner_unavailable, network) still throws.
 */
export async function syncDestinationNow(
  id: string,
  idempotencyKey: string,
): Promise<DestinationSyncNowResult> {
  const res = await rawRequest<unknown>(
    "POST",
    `${BASE}/${encodeURIComponent(id)}/sync`,
    {},
    { idempotencyKey },
  );
  if (res.error) {
    throw Object.assign(
      new Error(res.error.message || "The push was not started."),
      res.error,
    );
  }
  return parseSyncNowResult(res.data);
}

/** GET /{id}/preview — who would be pushed, and who the firewall withholds. */
export async function fetchDestinationPreview(
  id: string,
): Promise<DestinationPreview> {
  const res = await rawRequest<unknown>(
    "GET",
    `${BASE}/${encodeURIComponent(id)}/preview`,
  );
  if (res.error) {
    throw Object.assign(
      new Error(res.error.message || "Couldn't load the membership preview."),
      res.error,
    );
  }
  return parseDestinationPreview(res.data);
}

/**
 * GET /{id}/jobs/{job_id}/diagnostics — the provider's own answer for one
 * failed job. Refusals arrive as classified codes (409/502/503, handlers.go:
 * 584-643) and the thrown error keeps `code` + `status` so the sheet can say
 * the real reason instead of "couldn't load".
 */
export async function fetchDestinationJobDiagnostics(
  id: string,
  jobId: string,
): Promise<JobDiagnostics> {
  const res = await rawRequest<unknown>(
    "GET",
    `${BASE}/${encodeURIComponent(id)}/jobs/${encodeURIComponent(jobId)}/diagnostics`,
  );
  if (res.error) {
    throw Object.assign(
      new Error(res.error.message || "Couldn't load the job diagnostics."),
      res.error,
    );
  }
  return parseJobDiagnostics(res.data);
}
