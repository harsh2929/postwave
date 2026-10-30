// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Custom-domain release policy.
 *
 * Keep this synchronized with:
 *   - apps/desktop/src/lib/custom-domain-operational-availability.ts
 *   - apps/api/internal/custom_domains/custom_domains.go (requireMutationAvailable)
 *
 * A DNS ownership result is not proof that Moosewave can safely serve a
 * customer hostname. Mutations remain fail-closed until certificate issuance
 * and renewal, the dependency/teardown inventory, and production routing have
 * all been qualified end to end.
 */
export const CUSTOM_DOMAIN_REGISTRATION_AVAILABLE = false;
export const CUSTOM_DOMAIN_VERIFICATION_AVAILABLE = false;
export const CUSTOM_DOMAIN_REMOVAL_AVAILABLE = false;
export const CUSTOM_DOMAIN_AUTOMATED_TLS_AVAILABLE = false;
export const CUSTOM_DOMAIN_DEPENDENCY_INVENTORY_AVAILABLE = false;
export const CUSTOM_DOMAIN_PRODUCTION_ROUTING_AVAILABLE = false;

export const CUSTOM_DOMAIN_RELEASE_HOLD_MESSAGE =
  "Custom-domain registration, DNS re-verification, and removal are release-held until automated TLS issuance and renewal, authoritative dependency inventory and teardown, and production routing are qualified.";

export type CustomDomainMutationOperation =
  | "registration"
  | "verification"
  | "removal";

const CODES: Record<CustomDomainMutationOperation, string> = {
  registration: "custom_domain_registration_unavailable",
  verification: "custom_domain_verification_unavailable",
  removal: "custom_domain_removal_unavailable",
};

const AVAILABLE: Record<CustomDomainMutationOperation, boolean> = {
  registration: CUSTOM_DOMAIN_REGISTRATION_AVAILABLE,
  verification: CUSTOM_DOMAIN_VERIFICATION_AVAILABLE,
  removal: CUSTOM_DOMAIN_REMOVAL_AVAILABLE,
};

export class CustomDomainOperationUnavailableError extends Error {
  readonly code: string;
  readonly operation: CustomDomainMutationOperation;
  readonly status = 503;
  readonly retryable = false;

  constructor(operation: CustomDomainMutationOperation) {
    super(CUSTOM_DOMAIN_RELEASE_HOLD_MESSAGE);
    this.name = "CustomDomainOperationUnavailableError";
    this.code = CODES[operation];
    this.operation = operation;
  }
}

export function requireCustomDomainOperation(
  operation: CustomDomainMutationOperation,
): void {
  if (!AVAILABLE[operation]) {
    throw new CustomDomainOperationUnavailableError(operation);
  }
}

/**
 * Agency branding is a full-replacement endpoint. Preserve unrelated branding
 * writes, but refuse any request which would register, replace, or remove the
 * stored custom hostname.
 */
export function requireCustomDomainValueUnchanged(
  current: string | undefined,
  next: string | undefined,
): void {
  const before = current?.trim().toLowerCase() ?? "";
  const after = next?.trim().toLowerCase() ?? "";
  if (before === after) return;
  requireCustomDomainOperation(
    before && !after ? "removal" : "registration",
  );
}
