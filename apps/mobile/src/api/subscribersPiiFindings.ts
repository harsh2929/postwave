/**
 * api/subscribersPiiFindings.ts — Shadow-PII findings transport (SUB-071).
 *
 *   GET   /api/v1/pii-findings?status=&page=&per_page=   admin — review queue
 *   GET   /api/v1/subscribers/{id}/pii-findings          admin — one profile
 *   PATCH /api/v1/pii-findings/{id}                      admin — decide
 *
 * All three are admin-floored in the routeauth manifest AND mounted behind
 * apikeys.ScopeAdmin (pii_scanner/handlers.go:64) — the calling UI must not
 * exist below that role. The list routes reject unknown query parameters
 * outright, so this module only ever sends the documented three.
 *
 * Kept react-native-free (only impure import is ./request) so the node vitest
 * run pins the wire shapes with `rawRequest` mocked. UNWRAP BEFORE USING:
 * `rawRequest` resolves to the {data, error} ENVELOPE (api/request.ts:79);
 * errors surface as throws carrying `status` so the UI can say "admin
 * required" or "already decided" instead of a generic failure.
 */
import { rawRequest } from "@/api/request";

function surface(error: { message: string } | null, fallback: string): never {
  throw Object.assign(new Error(error?.message || fallback), error ?? {});
}

export interface PiiQueueParams {
  /** "" for all; otherwise pending | reviewed | dismissed. */
  status: string;
  page: number;
  perPage: number;
}

/** The workspace review queue. Returns the raw page body for the lib parser. */
export async function fetchPiiFindings(
  params: PiiQueueParams,
): Promise<unknown> {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  search.set("page", String(Math.max(1, Math.trunc(params.page) || 1)));
  search.set(
    "per_page",
    String(Math.min(200, Math.max(1, Math.trunc(params.perPage) || 50))),
  );
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/pii-findings?${search.toString()}`,
  );
  if (res.error) surface(res.error, "Couldn't load the PII review queue.");
  return res.data;
}

/** Findings recorded against ONE subscriber's fields. */
export async function fetchSubscriberPiiFindings(id: string): Promise<unknown> {
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/subscribers/${encodeURIComponent(id)}/pii-findings`,
  );
  if (res.error) surface(res.error, "Couldn't load this profile's findings.");
  return res.data;
}

/**
 * Commit one review decision. `body` is built by
 * lib/subscriberPiiFindings.buildPiiDecisionBody — this function never
 * invents body keys, and a null body must be refused by the caller before it
 * gets here.
 */
export async function reviewPiiFinding(
  id: string,
  body: Record<string, string>,
): Promise<unknown> {
  const res = await rawRequest<unknown>(
    "PATCH",
    `/api/v1/pii-findings/${encodeURIComponent(id)}`,
    body,
  );
  if (res.error) surface(res.error, "The decision was not recorded.");
  return res.data;
}
