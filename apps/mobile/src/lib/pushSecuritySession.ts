/**
 * Pure policy for the destructive action on a new-device sign-in push.
 *
 * The notification data bag is an input, never authority. A revoke target is
 * admitted only when all three wire values match: the dedicated action id, the
 * exact security event, and the canonical 16-byte raw-base64url public id
 * issued by auth_sessions. The caller still requires a validated cookie
 * session and an in-app confirmation before sending
 * DELETE /auth/sessions/{id}.
 */

export const NEW_DEVICE_SIGN_IN_EVENT = "auth.new_device_sign_in";
export const PUSH_ACTION_REVOKE_SESSION = "revoke_session";

// 16 raw bytes encode to 22 unpadded base64url characters. The final character
// contains only two data bits, so canonical encodings end in A/Q/g/w; accepting
// every alphabet character there would admit non-canonical aliases.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{21}[AQgw]$/u;

export interface PushSecurityActionLike {
  actionIdentifier: string;
  eventType: string;
  entityId: string;
}

/** Returns the exact one-session target, or null for every other payload. */
export function securitySessionRevokeTarget(
  action: PushSecurityActionLike | null | undefined,
): string | null {
  if (
    action?.actionIdentifier !== PUSH_ACTION_REVOKE_SESSION ||
    action.eventType !== NEW_DEVICE_SIGN_IN_EVENT ||
    !SESSION_ID_RE.test(action.entityId)
  ) {
    return null;
  }
  return action.entityId;
}

export type PushSecurityRevokeGate =
  | "confirm"
  | "retry_later"
  | "offline"
  | "session_required";

/**
 * Destructive notification actions require a currently validated cookie
 * session. API keys and cached/offline identities can review Settings but may
 * not turn an untrusted notification payload into a mutation.
 */
export function securitySessionRevokeGate(input: {
  mode: "api_key" | "session" | null | undefined;
  canUseOnlineServices: boolean;
  sessionValidation: string;
  retryable: boolean;
}): PushSecurityRevokeGate {
  if (input.mode !== "session") return "session_required";
  if (input.canUseOnlineServices) return "confirm";
  if (input.retryable && input.sessionValidation === "checking") {
    return "retry_later";
  }
  return "offline";
}
