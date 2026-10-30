/**
 * api/verificationProviders.ts — the vendor row behind every paid address check.
 *
 *   GET    /api/v1/verification/providers             (admin)
 *   PUT    /api/v1/verification/providers/{provider}  (admin)
 *   DELETE /api/v1/verification/providers/{provider}  (admin)
 *
 * ADMIN EVEN FOR THE READ, because the row points at a billable credential.
 * The card therefore ARMS the query only for admins rather than buying a
 * guaranteed 403 (the same rule the verification-policy card follows).
 *
 * THE PUT IS A FULL REPLACE. `putProvider` rebuilds the whole ProviderConfig
 * from the body: a request that omits `settings` resets ip_address,
 * degrade_on_failure and cache_ttl_days to their zero values, and one that
 * omits `credential_ref` is rejected outright. So a flip of `enabled` re-reads
 * the current row and echoes credential_ref and settings back verbatim.
 *
 * THE CREDENTIAL NEVER COMES BACK OUT. The re-read happens INSIDE the write
 * call: the ref is read from the response and handed straight to the PUT. It
 * is not parsed into the view type, not returned to a caller, not held in
 * component state, and not written to the query cache. Nothing in the mobile
 * app can render or persist it, which is the whole point — it is the handle to
 * a key that costs money per address.
 */
import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

import { WireShapeError } from "@/lib/deliverabilityContracts";
import {
  parseVerificationProviders,
  type VerificationProvidersView,
} from "@/lib/verificationProviders";

export class VerificationProvidersError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "VerificationProvidersError";
  }
}

/**
 * The server's machine-readable code for a failed provider read or write, or
 * "" for anything that never reached it. Exported so a component can choose
 * the right sentence without importing the error class.
 */
export function verificationProviderErrorCode(error: unknown): string {
  return error instanceof VerificationProvidersError ? (error.code ?? "") : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROVIDERS_PATH = "/api/v1/verification/providers";

function providerPath(provider: string): string {
  const name = provider.trim().toLowerCase();
  if (!name) throw new Error("verification provider name is required");
  return `${PROVIDERS_PATH}/${encodeURIComponent(name)}`;
}

export async function fetchVerificationProviders(): Promise<VerificationProvidersView> {
  const res = await rawRequest<unknown>("GET", PROVIDERS_PATH);
  if (res.error) {
    throw new VerificationProvidersError(
      res.error,
      "Couldn't load the verification vendors.",
    );
  }
  return parseVerificationProviders(res.data);
}

/**
 * Re-read one row for its immutable halves. Deliberately package-private: the
 * only legitimate consumer is the PUT immediately below it, in the same tick,
 * so the credential handle has no lifetime beyond one request pair.
 */
async function currentProviderRow(
  provider: string,
): Promise<{ credentialRef: string; settings: unknown }> {
  const res = await rawRequest<unknown>("GET", PROVIDERS_PATH);
  if (res.error) {
    throw new VerificationProvidersError(
      res.error,
      "Couldn't re-read the verification vendor before changing it.",
    );
  }
  if (!isRecord(res.data) || !Array.isArray(res.data.providers)) {
    throw new WireShapeError("verification providers");
  }
  const wanted = provider.trim().toLowerCase();
  const row = res.data.providers.find(
    (entry) =>
      isRecord(entry) &&
      typeof entry.provider === "string" &&
      entry.provider.trim().toLowerCase() === wanted,
  );
  if (!isRecord(row) || typeof row.credential_ref !== "string") {
    // Fail closed rather than PUT a blank credential_ref, which the server
    // rejects with invalid_credential_ref and which would read to an operator
    // as "the vendor broke" rather than "this row is gone".
    throw new Error(
      "That verification vendor is no longer configured for this workspace.",
    );
  }
  return { credentialRef: row.credential_ref, settings: row.settings };
}

/**
 * Turn the configured vendor on or off.
 *
 * This is the phone-appropriate half of vendor configuration. CREATING a
 * vendor is not: credential_ref names a secret that has to exist in the
 * workspace's server-side namespace before the row can resolve it, and a phone
 * is not where that secret gets provisioned.
 */
export async function setVerificationProviderEnabled(
  provider: string,
  enabled: boolean,
): Promise<void> {
  const path = providerPath(provider);
  const { credentialRef, settings } = await currentProviderRow(provider);
  const body: Record<string, unknown> = {
    credential_ref: credentialRef,
    enabled,
  };
  // Echo settings only when the server stated an object. Sending `null` or a
  // fabricated `{}` would be indistinguishable from "reset the tuned ones".
  if (isRecord(settings)) body.settings = settings;
  const res = await rawRequest<unknown>("PUT", path, body);
  if (res.error) {
    throw new VerificationProvidersError(
      res.error,
      enabled
        ? "Couldn't enable that verification vendor."
        : "Couldn't disable that verification vendor.",
    );
  }
}

export async function removeVerificationProvider(
  provider: string,
): Promise<void> {
  const res = await rawRequest<unknown>("DELETE", providerPath(provider));
  if (res.error) {
    throw new VerificationProvidersError(
      res.error,
      "Couldn't remove that verification vendor.",
    );
  }
}
