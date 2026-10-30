/**
 * passwordPolicy — ONE password policy for the whole app.
 *
 * Before this module there were three, and they disagreed in a user-visible
 * way: `app/(auth)/sign-up.tsx` hard-disabled "Create account" until a
 * password had 12+ chars AND an uppercase AND a digit AND a symbol, while
 * `src/components/auth/PasswordResetForm.tsx` rendered the identical four
 * rules as ADVICE and gated only on length. So a 24-character diceware
 * passphrase — stronger than "Passw0rd!" and exactly what a password manager
 * generates — was accepted at reset and rejected at sign-up, behind a greyed
 * out button with no explanation.
 *
 * The server (apps/api/internal/auth/handlers.go) enforces only
 * `len(password) >= 12`. This module aligns the blocking rule with the server
 * and keeps the character-class rules as guidance, which is the reset screen's
 * behaviour and the one that does not lock users out of good passwords.
 */

/** The only rule that BLOCKS submission — matches the server exactly. */
export const MIN_PASSWORD_LENGTH = 12;

export interface PasswordRule {
  key: "length" | "upper" | "number" | "symbol";
  label: string;
  ok: boolean;
  /** True when failing this rule prevents submission. */
  blocking: boolean;
}

export function passwordRules(value: string): PasswordRule[] {
  const pw = value ?? "";
  return [
    {
      key: "length",
      label: `${MIN_PASSWORD_LENGTH}+ characters`,
      ok: pw.length >= MIN_PASSWORD_LENGTH,
      blocking: true,
    },
    {
      key: "upper",
      label: "Uppercase letter",
      ok: /[A-Z]/.test(pw),
      blocking: false,
    },
    { key: "number", label: "Number", ok: /\d/.test(pw), blocking: false },
    {
      key: "symbol",
      label: "Symbol",
      ok: /[^A-Za-z0-9]/.test(pw),
      blocking: false,
    },
  ];
}

/**
 * The reason submission is blocked, or null when the password is acceptable.
 * Returned as copy rather than a boolean so the screen can announce WHY
 * instead of just disabling a button.
 */
export function passwordBlockingError(value: string): string | null {
  const pw = value ?? "";
  if (!pw) return "Enter a password.";
  if (pw.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

/** How many advisory rules are still unmet — drives the "make it stronger" hint. */
export function unmetAdvisoryRules(value: string): PasswordRule[] {
  return passwordRules(value).filter((rule) => !rule.blocking && !rule.ok);
}

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
}

/**
 * Best-effort strength heuristic. Length is weighted deliberately heavily so a
 * long passphrase scores well without symbols — the policy above accepts it,
 * and a meter that contradicts the gate is worse than no meter.
 */
export function passwordScore(value: string): PasswordStrength {
  const pw = value ?? "";
  if (!pw) return { score: 0, label: "" };
  let score = 0;
  if (pw.length >= MIN_PASSWORD_LENGTH) score++;
  if (pw.length >= 16) score++;
  if (pw.length >= 24) score++;
  else if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  const labels = ["very weak", "weak", "okay", "good", "strong"] as const;
  const clamped = Math.min(score, 4) as 0 | 1 | 2 | 3 | 4;
  return { score: clamped, label: labels[clamped] };
}
