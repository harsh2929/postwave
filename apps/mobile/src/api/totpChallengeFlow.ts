/**
 * api/totpChallengeFlow.ts — one attempt at the TOTP challenge, including the
 * AUTH#48 device-trust opt-in and the one retry it can require.
 *
 * WHY THIS IS NOT INLINE IN THE SCREEN. The retry below is a security-relevant
 * decision — "resend the user's ALREADY TYPED one-shot recovery code" — and it
 * is only safe because of a specific ordering guarantee on the server. That
 * reasoning deserves to sit next to the code that depends on it, and to be
 * exercised by a test, rather than to live in a component that no node-
 * environment test can import.
 *
 * THE GUARANTEE: `TOTPChallenge` (apps/api/internal/auth/totp_handlers.go)
 * calls `validateTrustRequest` BEFORE it verifies the code and before
 * `ConsumeRecoveryCode`. So a `device_trust_disabled` 403 — or an
 * `invalid_trust_duration` 400 — is returned with the credential UNSPENT. The
 * retry is therefore free, and it spares the user having to untick a box and
 * re-enter a recovery code they can only use once.
 *
 * A 401 `invalid_code` is NOT retried. That one really did consume the
 * credential.
 */
import type { AuthClient, AuthResult } from "./auth";
import type {
  TotpChallengeInput,
  TotpChallengeResult,
  TrustDurationDays,
} from "../lib/trustedDeviceContract";

/**
 * The error codes that mean "your trust request was refused, before anything
 * was spent". Both are produced by `validateTrustRequest`, which runs ahead of
 * every code path that consumes a credential.
 */
const TRUST_REFUSED_CODES = new Set([
  "device_trust_disabled",
  "invalid_trust_duration",
  "device_trust_policy_unavailable",
]);

export interface TotpChallengeAttempt {
  result: AuthResult<TotpChallengeResult>;
  /**
   * The workspace (or the server) refused the trust request and the challenge
   * was retried without it. The UI should stop offering the option and say so.
   */
  trustRefused: boolean;
}

export async function submitTotpChallenge(
  client: Pick<AuthClient, "totpChallenge">,
  credential: TotpChallengeInput,
  trust: { remember: boolean; days: TrustDurationDays },
): Promise<TotpChallengeAttempt> {
  if (!trust.remember) {
    return { result: await client.totpChallenge(credential), trustRefused: false };
  }
  const result = await client.totpChallenge({
    ...credential,
    trust_device: true,
    trust_days: trust.days,
  });
  const code = result.error?.code;
  if (code === undefined || !TRUST_REFUSED_CODES.has(code)) {
    return { result, trustRefused: false };
  }
  // Unspent credential (see the header): retry exactly once, without trust.
  return { result: await client.totpChallenge(credential), trustRefused: true };
}
