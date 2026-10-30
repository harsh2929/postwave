/**
 * api/privacyPortal.ts — transport for the privacy-portal operator surface.
 *
 * AUTHORIZATION. Every route below is family:admin in the routeauth manifest
 * (session floor owner|admin). The caller gates with the same
 * `canAccessMinimumRole("admin", ...)` check the Compliance screen already
 * performs, and still treats a live 403 as its own state.
 *
 * THE ROUTES:
 *   GET    /api/v1/privacy/portal                          summary (regions +
 *          consent_proof_summary + counts) — also read by Settings' posture
 *   GET    /api/v1/privacy/portal/double-optin/pending     pending queue
 *   POST   /api/v1/privacy/portal/double-optin/{id}/resend extend window
 *   POST   /api/v1/privacy/portal/double-optin/{id}/cancel delete pending row
 *   POST   /api/v1/privacy/portal/regions                  add region
 *   DELETE /api/v1/privacy/portal/regions/{id}             remove region
 *
 * EVERY WRITE IS ONLINE-ONLY, never the offline outbox: these are consent
 * governance actions. A region rule or a cancelled opt-in replayed hours
 * later would change which framework applies — or delete a row the
 * subscriber has since confirmed — out of the operator's sight.
 */
import {
  parsePendingDoubleOptins,
  type PendingDoubleOptinPage,
  type PrivacyRegionRow,
} from "@/lib/privacyPortalOps";

import { rawRequest, type AIApiError } from "./request";

const PORTAL = "/api/v1/privacy/portal";

/** How many pending rows one phone screen reads (server default is 500). */
export const DOUBLE_OPTIN_PAGE_SIZE = 50;

/** Keeps status + code so the UI can tell a 403 from a 409/404. */
export class PrivacyPortalError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "PrivacyPortalError";
    this.status = error.status;
    this.code = error.code;
  }
}

async function portalRequest<T>(
  method: string,
  path: string,
  label: string,
  body?: unknown,
): Promise<T | null> {
  const res = await rawRequest<T>(method, path, body);
  if (res.error) throw new PrivacyPortalError(res.error, label);
  return res.data;
}

/** The raw portal summary — parsed by lib/privacyPortalOps and lib/privacyPosture. */
export async function fetchPrivacyPortalOverview(): Promise<unknown> {
  return portalRequest<unknown>("GET", PORTAL, "Loading the privacy portal");
}

export async function listDoubleOptinPending(
  limit: number = DOUBLE_OPTIN_PAGE_SIZE,
): Promise<PendingDoubleOptinPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  const raw = await portalRequest<unknown>(
    "GET",
    `${PORTAL}/double-optin/pending?${params.toString()}`,
    "Loading pending double opt-ins",
  );
  return parsePendingDoubleOptins(raw);
}

/**
 * Extend one pending row's confirmation window (the server's `resend`).
 * See DOUBLE_OPTIN_EXTEND_COPY for what this does and does not claim.
 */
export async function extendDoubleOptin(id: string): Promise<void> {
  const trimmed = (id ?? "").trim();
  if (!trimmed) throw new Error("A pending row id is required.");
  await portalRequest<unknown>(
    "POST",
    `${PORTAL}/double-optin/${encodeURIComponent(trimmed)}/resend`,
    "Extending the confirmation window",
    {},
  );
}

/** Delete one pending row. The subscriber stays unconfirmed. */
export async function cancelDoubleOptin(id: string): Promise<void> {
  const trimmed = (id ?? "").trim();
  if (!trimmed) throw new Error("A pending row id is required.");
  await portalRequest<unknown>(
    "POST",
    `${PORTAL}/double-optin/${encodeURIComponent(trimmed)}/cancel`,
    "Cancelling the pending opt-in",
    {},
  );
}

export interface CreatePrivacyRegionInput {
  regionCode: string;
  framework: string;
  requiresDoubleOptIn: boolean;
  requiresExplicitConsent: boolean;
  doNotSellDefault: boolean;
  gpcHonored: boolean;
}

/** Add a region row. The server uppercases the code and 409s a duplicate. */
export async function createPrivacyRegion(
  input: CreatePrivacyRegionInput,
): Promise<PrivacyRegionRow | null> {
  const raw = await portalRequest<Record<string, unknown>>(
    "POST",
    `${PORTAL}/regions`,
    "Adding the region",
    {
      region_code: input.regionCode.trim().toUpperCase(),
      framework: input.framework.trim().toLowerCase(),
      requires_double_optin: input.requiresDoubleOptIn,
      requires_explicit_consent: input.requiresExplicitConsent,
      do_not_sell_default: input.doNotSellDefault,
      gpc_honored: input.gpcHonored,
    },
  );
  if (!raw || typeof raw !== "object") return null;
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    regionCode: typeof raw.region_code === "string" ? raw.region_code : "",
    framework: typeof raw.framework === "string" ? raw.framework : "other",
    requiresDoubleOptIn: raw.requires_double_optin === true,
    requiresExplicitConsent: raw.requires_explicit_consent === true,
    doNotSellDefault: raw.do_not_sell_default === true,
    gpcHonored: raw.gpc_honored === true,
  };
}

/** Remove a region row (204 on success, 404 when already gone). */
export async function deletePrivacyRegion(id: string): Promise<void> {
  const trimmed = (id ?? "").trim();
  if (!trimmed) throw new Error("A region id is required.");
  await portalRequest<unknown>(
    "DELETE",
    `${PORTAL}/regions/${encodeURIComponent(trimmed)}`,
    "Removing the region",
  );
}
