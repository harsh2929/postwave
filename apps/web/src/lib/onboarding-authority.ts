// SPDX-License-Identifier: AGPL-3.0-only

import {
  effectiveAuthRole,
  whoamiFresh,
  type AuthRole,
  type MeResponse,
} from "@/lib/auth-api";
import { newUUIDv7 } from "@/lib/http-fetch";
import { qk, type RoleKey } from "@/lib/query-keys";
import type { OnboardingDecisionState } from "@postwave/onboarding-schema";

export interface OnboardingAuthority {
  tenantId: string;
  userId: string;
  role: RoleKey;
  viewerMode: boolean;
  key: string;
}

export interface FrozenOnboardingDecision {
  readonly stepKey: string;
  readonly state: OnboardingDecisionState;
  readonly reason?: string;
}

export interface OnboardingDecisionAttempt {
  readonly authority: OnboardingAuthority;
  readonly authorityKey: string;
  readonly controller: AbortController;
  readonly idempotencyKey: string;
  readonly intent: FrozenOnboardingDecision;
}

function scopePart(value: string): string {
  return `${value.length}:${value}`;
}

export function onboardingAuthorityKey(
  tenantId: string,
  userId: string,
  role: RoleKey,
  viewerMode: boolean,
): string {
  return [
    scopePart(tenantId),
    scopePart(userId),
    scopePart(role ?? "unresolved"),
    viewerMode ? "viewer-mode" : "member-mode",
  ].join("|");
}

export function onboardingAuthorityFromFields({
  tenantId,
  userId,
  role,
  viewerMode,
}: {
  tenantId?: string | null;
  userId?: string | null;
  role?: RoleKey;
  viewerMode?: boolean;
}): OnboardingAuthority {
  const resolvedTenant = tenantId || "anon";
  const resolvedUser = userId || "unverified";
  const resolvedRole = role ?? null;
  const resolvedViewerMode = viewerMode === true;
  return {
    tenantId: resolvedTenant,
    userId: resolvedUser,
    role: resolvedRole,
    viewerMode: resolvedViewerMode,
    key: onboardingAuthorityKey(
      resolvedTenant,
      resolvedUser,
      resolvedRole,
      resolvedViewerMode,
    ),
  };
}

export function onboardingAuthorityFromMe(me: MeResponse): OnboardingAuthority {
  return onboardingAuthorityFromFields({
    tenantId: me.tenant_id,
    userId: me.user_id,
    role: effectiveAuthRole(me),
    viewerMode: me.viewer_mode === true,
  });
}

export function onboardingAuthorityReady(
  authority: OnboardingAuthority,
): boolean {
  return (
    authority.tenantId !== "anon" &&
    authority.userId !== "unverified" &&
    authority.role !== null
  );
}

export function onboardingIdentitySuffix(
  authority: OnboardingAuthority,
): readonly [string, "viewer" | "member"] {
  return [authority.userId, authority.viewerMode ? "viewer" : "member"];
}

export function onboardingProgressKey(authority: OnboardingAuthority) {
  return [
    ...qk.onboardingProgress(authority.tenantId, authority.role),
    ...onboardingIdentitySuffix(authority),
  ] as const;
}

export function onboardingDecisionsKey(authority: OnboardingAuthority) {
  return [
    ...qk.onboardingDecisions(authority.tenantId, authority.role),
    ...onboardingIdentitySuffix(authority),
  ] as const;
}

export function onboardingRoleCanDecide(role: RoleKey): role is AuthRole {
  return role === "owner" || role === "admin" || role === "editor";
}

export function onboardingCanDecide(authority: OnboardingAuthority): boolean {
  return (
    onboardingAuthorityReady(authority) &&
    !authority.viewerMode &&
    onboardingRoleCanDecide(authority.role)
  );
}

export function assertOnboardingDecisionAuthority(
  authority: OnboardingAuthority,
): void {
  if (!onboardingAuthorityReady(authority)) {
    throw new Error("Your onboarding identity is still being verified.");
  }
  if (authority.viewerMode) {
    throw new Error(
      "Viewer mode is read-only. Exit viewer mode before changing onboarding preferences.",
    );
  }
  if (!onboardingRoleCanDecide(authority.role)) {
    throw new Error(
      "This role can view onboarding progress but cannot change onboarding preferences.",
    );
  }
}

export async function verifyFreshOnboardingAuthority(
  expected: OnboardingAuthority,
  signal: AbortSignal,
): Promise<void> {
  assertOnboardingDecisionAuthority(expected);
  const fresh = onboardingAuthorityFromMe(await whoamiFresh(signal));
  if (fresh.key !== expected.key || !onboardingCanDecide(fresh)) {
    throw new Error(
      "Your workspace identity or onboarding access changed. Nothing was saved.",
    );
  }
}

export function freezeOnboardingDecision(
  stepKey: string,
  state: OnboardingDecisionState,
  reason?: string,
): FrozenOnboardingDecision {
  const normalizedReason = reason?.trim();
  return Object.freeze({
    stepKey,
    state,
    ...(normalizedReason ? { reason: normalizedReason } : {}),
  });
}

let activeAttempt: OnboardingDecisionAttempt | null = null;

/**
 * Checklist and tour decisions share this synchronous lock. A second click or
 * another surface cannot enqueue a conflicting replacement before React has
 * committed the first mutation's pending state.
 */
export function beginOnboardingDecisionAttempt(
  authority: OnboardingAuthority,
  intent: FrozenOnboardingDecision,
): OnboardingDecisionAttempt | null {
  assertOnboardingDecisionAuthority(authority);
  if (activeAttempt) return null;
  const attempt: OnboardingDecisionAttempt = Object.freeze({
    authority,
    authorityKey: authority.key,
    controller: new AbortController(),
    idempotencyKey: newUUIDv7(),
    intent,
  });
  activeAttempt = attempt;
  return attempt;
}

export function endOnboardingDecisionAttempt(
  attempt: OnboardingDecisionAttempt,
): void {
  if (activeAttempt === attempt) activeAttempt = null;
}

export function abortOnboardingDecisionAttempt(
  attempt: OnboardingDecisionAttempt,
): void {
  attempt.controller.abort();
  endOnboardingDecisionAttempt(attempt);
}
