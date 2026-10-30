/**
 * useVendorVerify — the one mobile mutation that can spend a vendor credit.
 *
 * NEVER RETRIED AUTOMATICALLY. The server answers an uncertain outcome with a
 * 409 exactly so nobody repeats a request that may already have been charged,
 * and a transport failure is no different: the address may have reached the
 * vendor. A repeat only happens because a person pressed again, and when they
 * do, lib/vendorVerify hands back the SAME idempotency key so the server
 * replays instead of re-charging.
 */
import { useMutation } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";

import {
  verifyAddressWithVendor,
  type VendorVerifyError,
} from "@/api/vendorVerify";

import type { VendorVerifyResult } from "@/lib/vendorVerify";

/** A fresh Idempotency-Key: one printable value well inside the 255-byte cap. */
export function mintVendorVerifyKey(): string {
  return `mobile-verify-${Crypto.randomUUID()}`;
}

export function useVerifyAddressWithVendor() {
  return useMutation<
    VendorVerifyResult,
    Error | VendorVerifyError,
    { email: string; idempotencyKey: string }
  >({
    retry: false,
    mutationFn: (input) => verifyAddressWithVendor(input),
  });
}
