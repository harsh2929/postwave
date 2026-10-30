// SPDX-License-Identifier: AGPL-3.0-only

import type { ApiResult } from "./api/result";

/**
 * Keep synchronized with the web policy module and custom_domains.Deps.
 * Authenticated legacy reads remain available; every hostname mutation is
 * fail-closed until the complete serving lifecycle is qualified.
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

export function heldCustomDomainResult<T>(
  operation: CustomDomainMutationOperation,
): ApiResult<T> {
  return {
    error: {
      status: 503,
      code: CODES[operation],
      kind: "http",
      message: CUSTOM_DOMAIN_RELEASE_HOLD_MESSAGE,
    },
    retryability: "not-retryable",
  };
}
