// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure one-time-code (TOTP) input helpers (AUTH-017). Sanitising to digits and
// deciding "is this complete?" lives here so the input handling is unit-tested
// and the challenge page can auto-submit the moment a full code is entered.

/** Length of a TOTP one-time code. */
export const OTP_LENGTH = 6;

/** Strip non-digits and clamp to the OTP length. */
export function sanitizeOtp(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, OTP_LENGTH);
}

/** True when a (sanitised) code is exactly OTP_LENGTH digits. */
export function isOtpComplete(code: string): boolean {
  return code.length === OTP_LENGTH && /^\d+$/.test(code);
}
