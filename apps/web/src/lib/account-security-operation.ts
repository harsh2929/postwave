// SPDX-License-Identifier: AGPL-3.0-only

import { newUUIDv7 } from "@/lib/http-fetch";

export interface AccountSecurityOperation {
  readonly controller: AbortController;
  readonly idempotencyKey: string;
  readonly principalKey: string;
  readonly kind: string;
}

let activeOperation: AccountSecurityOperation | null = null;

/**
 * Account-security mutations share one synchronous lock. TOTP, passkeys,
 * trusted-device bypasses, sessions, and linked login methods all affect the
 * same authentication graph; allowing two cards to mutate it concurrently can
 * make either card's lockout/readback decision stale before it is submitted.
 */
export function beginAccountSecurityOperation(
  principalKey: string,
  kind: string,
): AccountSecurityOperation {
  if (principalKey === "unverified") {
    throw new Error("Verify your account before changing security settings.");
  }
  if (activeOperation) {
    throw new Error(
      "Another account-security change is already in progress. Wait for it to finish and try again.",
    );
  }
  const operation: AccountSecurityOperation = {
    controller: new AbortController(),
    idempotencyKey: newUUIDv7(),
    principalKey,
    kind,
  };
  activeOperation = operation;
  return operation;
}

export function accountSecurityOperationIsCurrent(
  operation: AccountSecurityOperation,
  currentPrincipalKey: string,
): boolean {
  return (
    !operation.controller.signal.aborted &&
    activeOperation === operation &&
    operation.principalKey === currentPrincipalKey
  );
}

/** Only the operation that acquired the lock can release it. */
export function finishAccountSecurityOperation(
  operation: AccountSecurityOperation,
): void {
  operation.controller.abort();
  if (activeOperation === operation) activeOperation = null;
}

/** Abort account writes when their exact principal leaves the mounted tree. */
export function abortAccountSecurityOperationForPrincipal(
  principalKey: string,
): void {
  if (activeOperation?.principalKey !== principalKey) return;
  activeOperation.controller.abort();
  activeOperation = null;
}
