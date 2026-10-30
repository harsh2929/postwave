// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure password-strength evaluation backing the signup / reset-password live
// feedback (AUTH-004). Kept free of React/DOM so it unit-tests under the
// node-only vitest environment. This is advisory UX only — the backend remains
// the source of truth for password policy; we never gate submit on the score,
// only on the hard length minimum the API enforces.

/** Minimum password length the backend enforces (mirrored client-side). */
export const MIN_PASSWORD_LENGTH = 12;

export type PasswordScore = 0 | 1 | 2 | 3 | 4;

export interface PasswordAssessment {
  /** Raw length of the candidate password. */
  length: number;
  /** True once the hard length minimum is met. */
  lengthMet: boolean;
  /** 0 (too short) … 4 (strong). Capped at 1 while below the minimum. */
  score: PasswordScore;
  /** Human label for the current score. */
  label: string;
  /** Score expressed as a 0–100 meter fill. */
  percent: number;
}

const LABELS = ["Too short", "Weak", "Fair", "Good", "Strong"] as const;

/**
 * Evaluate a candidate password. Deterministic and side-effect free.
 *
 * The score blends length and character-class variety, but is deliberately
 * capped at "Weak" until the hard minimum length is reached so the meter can
 * never read "Good"/"Strong" for a password the backend will reject.
 */
export function evaluatePassword(password: string): PasswordAssessment {
  const length = password.length;
  const lengthMet = length >= MIN_PASSWORD_LENGTH;

  let raw = 0;
  if (lengthMet) raw += 1;
  if (length >= MIN_PASSWORD_LENGTH + 4) raw += 1;

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  if (classes >= 2) raw += 1;
  if (classes >= 3) raw += 1;

  // Never advertise strength for a password below the enforced minimum.
  if (!lengthMet) raw = Math.min(raw, 1);
  const score = Math.max(0, Math.min(4, raw)) as PasswordScore;

  return {
    length,
    lengthMet,
    score,
    label: LABELS[score],
    percent: (score / 4) * 100,
  };
}
