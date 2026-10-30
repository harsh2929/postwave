// SPDX-License-Identifier: AGPL-3.0-only

import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const authorityBrand = Symbol("audience-activation-admin-authority");

export class AudienceActivationContractError extends Error {
  constructor(
    message = "The audience activation service returned an unverifiable response. Refresh before trying again.",
  ) {
    super(message);
    this.name = "AudienceActivationContractError";
  }
}

export class AudienceActivationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudienceActivationInputError";
  }
}

export interface AudienceActivationAdminAuthority {
  readonly tenantId: string;
  readonly userId: string;
  readonly [authorityBrand]: true;
}

export function isCanonicalAudienceActivationId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function authorizeAudienceActivationAdmin(
  me: MeResponse,
  expectedTenantId: string,
  expectedUserId: string,
): AudienceActivationAdminAuthority {
  const role = effectiveAuthRole(me);
  if (
    !isCanonicalAudienceActivationId(expectedTenantId) ||
    !isCanonicalAudienceActivationId(expectedUserId) ||
    me.tenant_id !== expectedTenantId ||
    me.user_id !== expectedUserId ||
    me.viewer_mode === true ||
    (role !== "owner" && role !== "admin")
  ) {
    throw new AudienceActivationInputError(
      "Your workspace identity or effective admin role changed.",
    );
  }
  return Object.freeze({
    tenantId: expectedTenantId,
    userId: expectedUserId,
    [authorityBrand]: true as const,
  });
}

export function assertAudienceActivationAuthority(
  value: AudienceActivationAdminAuthority,
): asserts value is AudienceActivationAdminAuthority {
  if (
    typeof value !== "object" ||
    value === null ||
    value[authorityBrand] !== true ||
    !isCanonicalAudienceActivationId(value.tenantId) ||
    !isCanonicalAudienceActivationId(value.userId)
  ) {
    throw new AudienceActivationInputError(
      "Fresh tenant-bound admin authorization is required.",
    );
  }
}

export function assertAudienceActivationId(value: string, label: string): void {
  if (!isCanonicalAudienceActivationId(value)) {
    throw new AudienceActivationInputError(`${label} id is malformed.`);
  }
}

export function assertAudienceActivationIdempotencyKey(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 255 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new AudienceActivationInputError(
      "A stable 1–255 byte idempotency key is required.",
    );
  }
}
