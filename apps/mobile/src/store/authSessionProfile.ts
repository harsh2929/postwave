/**
 * store/authSessionProfile.ts
 *
 * The cached identity blob and its sanitiser. Extracted from store/auth.ts
 * (AUTH#60).
 *
 * This module is deliberately IO-free: it only translates between /me's wire
 * shape, the on-device blob, and the in-memory profile. Everything that can
 * touch the keychain lives in authPersistence.ts.
 *
 * Two invariants that must not be relaxed:
 *
 *   1. sanitizeSessionProfile is the ONLY constructor of a SessionProfile that
 *      the store trusts. A blob that fails it is treated as absent, never as a
 *      partially-usable identity.
 *
 *   2. mfaStatus is a PROJECTION of (mfaRequired, mfaSatisfied) — never an
 *      input. A stored `satisfied` can therefore never outrank /me.
 */
import type { AuthMeResponse } from "@/api/auth";

import { utf8ByteLength } from "../lib/utf8";

export type MfaStatus = "pending" | "satisfied" | "not_required";

export const MAX_STORED_SESSION_BYTES = 16 * 1024;
const MAX_STORED_SESSION_FIELD_CHARS = 512;
const SESSION_CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface SessionProfile {
  email: string;
  userId: string;
  tenantId: string;
  role: string;
  effectiveRole: string;
  viewerMode: boolean;
  authProvider: string;
  emailVerified: boolean;
  canUseViewerMode: boolean;
  workspaceName?: string;
  workspaceSlug?: string;
  /** Canonical /me factor-enrollment state. */
  totpEnabled: boolean;
  /** Canonical /me tenant-policy decision for this durable role. */
  mfaRequired: boolean;
  /** Canonical /me state for the current cookie session. */
  mfaSatisfied: boolean;
  /** Compatibility alias for settings/account deletion; equals totpEnabled. */
  hasTotp: boolean;
  /** Compatibility projection; never accepted as authoritative over /me. */
  mfaStatus: MfaStatus;
}

export function sessionProfileFromMe(me: AuthMeResponse): SessionProfile {
  const totpEnabled = me.totp_enabled;
  const mfaRequired = me.mfa_required;
  const mfaSatisfied = me.mfa_satisfied;
  return {
    email: me.email,
    userId: me.user_id,
    tenantId: me.tenant_id,
    role: me.role,
    effectiveRole: me.effective_role || me.role,
    viewerMode: Boolean(me.viewer_mode),
    authProvider: me.auth_provider,
    emailVerified: me.email_verified,
    canUseViewerMode: Boolean(me.can_use_viewer_mode),
    ...(me.workspace_name ? { workspaceName: me.workspace_name } : {}),
    ...(me.workspace_slug ? { workspaceSlug: me.workspace_slug } : {}),
    totpEnabled,
    mfaRequired,
    mfaSatisfied,
    hasTotp: totpEnabled,
    mfaStatus: derivedMfaStatus(mfaRequired, mfaSatisfied),
  };
}

function boundedSessionString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (
    value.length === 0 ||
    value.length > MAX_STORED_SESSION_FIELD_CHARS ||
    value.trim() !== value ||
    SESSION_CONTROL_RE.test(value)
  ) {
    return null;
  }
  return value;
}

export function derivedMfaStatus(
  mfaRequired: boolean,
  mfaSatisfied: boolean,
): MfaStatus {
  if (!mfaRequired) return "not_required";
  return mfaSatisfied ? "satisfied" : "pending";
}

export function sanitizeSessionProfile(
  profile: Partial<SessionProfile>,
): SessionProfile | null {
  const email = boundedSessionString(profile.email);
  const userId = boundedSessionString(profile.userId);
  const tenantId = boundedSessionString(profile.tenantId);
  if (!email || !userId || !tenantId) return null;
  const role = boundedSessionString(profile.role) ?? "member";
  const effectiveRole = boundedSessionString(profile.effectiveRole) ?? role;
  const authProvider = boundedSessionString(profile.authProvider) ?? "password";
  const workspaceName = boundedSessionString(profile.workspaceName);
  const workspaceSlug = boundedSessionString(profile.workspaceSlug);
  const legacyStatus =
    profile.mfaStatus === "pending" ||
    profile.mfaStatus === "satisfied" ||
    profile.mfaStatus === "not_required"
      ? profile.mfaStatus
      : null;
  const totpEnabled =
    typeof profile.totpEnabled === "boolean"
      ? profile.totpEnabled
      : Boolean(profile.hasTotp);
  // One-time migration for profiles written before /me's explicit MFA fields
  // were modelled. Conservatively keep old pending/satisfied profiles behind
  // the gate until the launch-time /me refresh replaces these projections.
  const mfaRequired =
    typeof profile.mfaRequired === "boolean"
      ? profile.mfaRequired
      : legacyStatus === "pending" || legacyStatus === "satisfied";
  const mfaSatisfied =
    typeof profile.mfaSatisfied === "boolean"
      ? profile.mfaSatisfied
      : legacyStatus === "satisfied";
  const normalized: SessionProfile = {
    email,
    userId,
    tenantId,
    role,
    effectiveRole,
    viewerMode: Boolean(profile.viewerMode),
    authProvider,
    emailVerified: Boolean(profile.emailVerified),
    canUseViewerMode: Boolean(profile.canUseViewerMode),
    ...(workspaceName ? { workspaceName } : {}),
    ...(workspaceSlug ? { workspaceSlug } : {}),
    totpEnabled,
    mfaRequired,
    mfaSatisfied,
    hasTotp: totpEnabled,
    mfaStatus: derivedMfaStatus(mfaRequired, mfaSatisfied),
  };
  if (utf8ByteLength(JSON.stringify(normalized)) > MAX_STORED_SESSION_BYTES) {
    return null;
  }
  return normalized;
}
