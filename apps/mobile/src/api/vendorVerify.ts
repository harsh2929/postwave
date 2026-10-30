/**
 * api/vendorVerify.ts — one live, paid vendor check.
 *
 *   POST /api/v1/verification/verify  (editor — spending money is a write,
 *                                      whatever the HTTP verb says)
 *
 * THE KEY IS ALWAYS EXPLICIT. The handler requires exactly one
 * Idempotency-Key header and rejects the request without one, and the SDK
 * auto-mints a FRESH key for any keyless POST. Letting it do that would mean
 * every press — including the panicky second press after a timeout — arrives
 * as a brand-new billable request. So the caller owns the key, and
 * lib/vendorVerify decides when a new one is warranted.
 *
 * The synchronous BATCH route (`/verify-batch`) is deliberately not wrapped
 * here: its server ceiling is MaxSynchronousBatch = 8 addresses, and a phone
 * has no eight-address selection to feed it. Bulk work is the durable job
 * route, which mobile already watches and can stop.
 */
import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

import {
  normalizeVerifyAddress,
  parseVendorVerifyResult,
  vendorVerifyInputError,
  type VendorVerifyResult,
} from "@/lib/vendorVerify";

export class VendorVerifyError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "VendorVerifyError";
  }
}

/**
 * True when the request may already have crossed the billable boundary.
 *
 * The server answers both of these with 409 precisely so the client does NOT
 * retry: the charge is uncertain and repeating it could double it. Callers
 * surface the message and stop.
 */
export function vendorVerifyOutcomeAmbiguous(error: unknown): boolean {
  if (!(error instanceof VendorVerifyError)) return false;
  return (
    error.code === "verification_provider_outcome_ambiguous" ||
    error.code === "verification_usage_outcome_ambiguous"
  );
}

/**
 * The server's machine-readable code for a failed check, or "" for anything
 * that never reached the server (an input refusal, a transport fault).
 *
 * Exported so a component can pick the right sentence without importing the
 * error class or reaching into an untyped `.code`.
 */
export function vendorVerifyErrorCode(error: unknown): string {
  return error instanceof VendorVerifyError ? (error.code ?? "") : "";
}

export async function verifyAddressWithVendor(input: {
  email: string;
  /** Required. See the file header — never let the SDK mint this. */
  idempotencyKey: string;
}): Promise<VendorVerifyResult> {
  const email = normalizeVerifyAddress(input.email);
  const invalid = vendorVerifyInputError(email);
  if (invalid) throw new Error(invalid);
  const key = input.idempotencyKey.trim();
  if (!key || key !== input.idempotencyKey || key.length > 255) {
    // The server's own rule: one printable value of 1-255 bytes, untrimmed.
    // Failing here keeps a malformed key from reading as a provider fault.
    throw new Error("A verification idempotency key is required.");
  }
  const res = await rawRequest<unknown>(
    "POST",
    "/api/v1/verification/verify",
    { email },
    { idempotencyKey: key },
  );
  if (res.error) {
    throw new VendorVerifyError(
      res.error,
      "Couldn't check that address with the vendor.",
    );
  }
  return parseVendorVerifyResult(res.data);
}
