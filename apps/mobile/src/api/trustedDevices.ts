/**
 * api/trustedDevices.ts — the AUTH#48 "remember this device" management
 * surface.
 *
 *   GET    /api/v1/auth/trusted-devices             what can skip my 2FA
 *   DELETE /api/v1/auth/trusted-devices/{id}        kill one
 *   POST   /api/v1/auth/trusted-devices/revoke-all  kill everything
 *
 * (apps/api/internal/auth/device_trust_handlers.go, mounted in the
 * authenticated tenant-resolved group by identity_api.go and gated
 * session-only / viewer-minimum by the routeauth manifest.)
 *
 * WHY THIS IS A SEPARATE CLIENT FROM `authSessions.ts`. A trust record is not
 * a session. It survives logout, it survives session expiry, and its whole
 * purpose is to let a NEW session start already MFA-satisfied. Folding it into
 * the sessions client would invite exactly the confusion the server is careful
 * to avoid — that "sign out everywhere" also revokes trust. It does not, and
 * these verbs are how the user does that.
 *
 * Everything goes through `authRequest`, so it inherits the cookie round-trip,
 * the `X-Postwave-Client` CSRF header, the AuthApiError envelope, the
 * `mfa_required` observer and the response-size guards.
 */
import { authRequest, type AuthResult } from "./auth";
import {
  parseTrustedDevicesPayload,
  type TrustedDeviceInfo,
  type TrustedDevicesPolicy,
} from "../lib/trustedDeviceContract";

export type { TrustedDeviceInfo, TrustedDevicesPolicy };

export async function listTrustedDevices(
  baseUrl: string,
): Promise<AuthResult<TrustedDevicesPolicy>> {
  const res = await authRequest<unknown>(
    baseUrl,
    "/api/v1/auth/trusted-devices",
  );
  if (res.error) return { error: res.error };
  // Shape validation lives in the import-free contract module, where a node
  // test can exercise every malformed-row case without a transport.
  return { data: parseTrustedDevicesPayload(res.data) };
}

export function revokeTrustedDevice(
  baseUrl: string,
  id: string,
): Promise<AuthResult<{ revoked: boolean }>> {
  return authRequest<{ revoked: boolean }>(
    baseUrl,
    `/api/v1/auth/trusted-devices/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

/**
 * The panic button. After this returns, every device — including this one —
 * is back to a full second factor.
 */
export function revokeAllTrustedDevices(
  baseUrl: string,
): Promise<AuthResult<{ revoked_count: number }>> {
  return authRequest<{ revoked_count: number }>(
    baseUrl,
    "/api/v1/auth/trusted-devices/revoke-all",
    { method: "POST" },
  );
}
