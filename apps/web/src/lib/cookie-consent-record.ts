// SPDX-License-Identifier: AGPL-3.0-only
//
// The stored cookie-consent record, and the one place its age is judged.
//
// Two published documents promise the record expires:
//
//   /legal/privacy §7   "Cookie consent record — 13 months — Re-consent timer"
//   /legal/cookies      register row: moosewave.cookie.consent.v1, "13 months"
//
// The banner wrote `ts` into the record from the beginning and nothing ever
// read it — readPrefs() did not even declare the field on its parse type. So
// consent never expired: a visitor who accepted analytics once was captured on
// that decision indefinitely, which is the direction that actually matters
// (a stale *rejection* is merely over-conservative, a stale *grant* is not).
//
// This lives in its own module because there are two independent readers —
// the banner decides whether to re-prompt, telemetry decides whether to
// capture — and they already duplicate the storage key and the byte cap. If
// only the banner expired the record, it would re-prompt while telemetry kept
// capturing against the record still sitting in localStorage.
//
// Failure direction is deliberate: anything we cannot positively date is
// treated as expired, matching the rule telemetry.ts already applies to
// unreadable storage ("we cannot prove consent; fail closed"). The cost is one
// extra prompt; the alternative is capturing without provable consent.

export const CONSENT_STORAGE_KEY = "moosewave.cookie.consent.v1";
export const MAX_COOKIE_PREFS_BYTES = 4 * 1024;

/** The published re-consent window, in calendar months. */
export const CONSENT_MAX_AGE_MONTHS = 13;

export interface ConsentPrefs {
  essential: true;
  analytics: boolean;
  marketing: boolean;
}

/**
 * Whether a consent record stamped at `iso` is still inside the published
 * window.
 *
 * Calendar arithmetic rather than a fixed day count, because "13 months" is a
 * calendar promise and 13 × 30 days would expire consent early. A stamp on the
 * 31st lands on an overflow date (e.g. 31 Jan + 13 months → 3 Mar), extending
 * the window by up to three days; erring long by days is acceptable where
 * erring short would revoke consent the policy says is still valid.
 */
export function isConsentCurrent(iso: unknown, now: Date): boolean {
  if (typeof iso !== "string" || iso === "") return false;
  const stamped = new Date(iso);
  const ms = stamped.getTime();
  if (Number.isNaN(ms)) return false;
  // A record stamped in the future cannot be dated either — clock skew or a
  // tampered entry. Treat it the same as an absent stamp.
  if (ms > now.getTime()) return false;
  const expires = new Date(stamped);
  expires.setMonth(expires.getMonth() + CONSENT_MAX_AGE_MONTHS);
  return now.getTime() < expires.getTime();
}

/**
 * Parse the stored record, returning prefs only when the entry is well-formed,
 * within the size cap, and inside the re-consent window. `null` means "no
 * usable decision" — callers should re-prompt and must not capture.
 *
 * `oversize` reports that the entry exceeded the byte cap so the caller can
 * evict it; the existing readers both delete on that condition.
 */
export function parseConsentRecord(
  raw: string | null,
  now: Date,
): { prefs: ConsentPrefs | null; oversize: boolean } {
  if (!raw) return { prefs: null, oversize: false };
  if (new TextEncoder().encode(raw).byteLength > MAX_COOKIE_PREFS_BYTES) {
    return { prefs: null, oversize: true };
  }
  try {
    const parsed = JSON.parse(raw) as { prefs?: ConsentPrefs; ts?: unknown };
    if (!isConsentCurrent(parsed.ts, now))
      return { prefs: null, oversize: false };
    if (
      parsed.prefs?.essential === true &&
      typeof parsed.prefs.analytics === "boolean" &&
      typeof parsed.prefs.marketing === "boolean"
    ) {
      return { prefs: parsed.prefs, oversize: false };
    }
    return { prefs: null, oversize: false };
  } catch {
    return { prefs: null, oversize: false };
  }
}
