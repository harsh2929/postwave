// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Display-side redaction for model-authored analytics text (the anomaly
 * brief's summary, probable causes and suggested actions).
 *
 * A port of desktop's `safeModelText` (apps/desktop/src/components/dashboard/
 * AnomalyBriefModal.tsx). The model reads raw workspace events, so its prose can
 * echo a subscriber's email, a profile id, a phone number, a link or a pasted
 * credential. None of that belongs in a brief an operator screenshots or shares,
 * so it is redacted before display — the deterministic evidence rendered next to
 * the brief is where the operator verifies facts.
 *
 * Keep these patterns in step with desktop's: the two clients must redact the
 * same things.
 */

export const MAX_BRIEF_NARRATIVE_LENGTH = 4_000;
export const MAX_BRIEF_LIST_ITEM_LENGTH = 1_000;
export const MAX_BRIEF_INSIGHT_ITEMS = 8;

const CONTROL_OR_BIDI_PATTERN = /[\p{Cc}\p{Cf}]+/gu;
const EMAIL_PATTERN =
  /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/giu;
const PHONE_PATTERN =
  /(^|[^a-z0-9])(?:\+?\d[\d\s().-]{7,}\d)(?=$|[^a-z0-9])/giu;
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const EXPLICIT_PROFILE_IDENTIFIER_PATTERN =
  /\b(?:subscriber|profile)[\s_-]*(?:id|identifier|key)\s*(?::|=|#|\bis\b)?\s*["']?[a-z0-9][a-z0-9._:@/-]{1,319}["']?/giu;
const LABELED_PROFILE_PATTERN =
  /\b(?:subscriber|profile)\s*(?::|#)\s*["']?[a-z0-9][a-z0-9._:@/-]{1,319}["']?/giu;
const PREFIXED_PROFILE_IDENTIFIER_PATTERN =
  /\b(?:subscriber|profile)[_-][a-z0-9][a-z0-9_-]{2,319}\b/giu;
const LINK_PATTERN =
  /\b(?:https?|ftp|file|mailto|data|javascript):(?:\/\/)?[^\s<>"']+/giu;
const BARE_DOMAIN_PATTERN =
  /\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[^\s<>"']*)?/giu;
const NAMED_CREDENTIAL_PATTERN =
  /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key|password|token|secret|authorization|session|cookie)\b\s*[:=]\s*(?:bearer[\s-]+)?[^\s,;]+/giu;
const BEARER_PATTERN = /\bbearer\s+[a-z0-9._~+/-]+/giu;
const TOKEN_PATTERN =
  /\b(?:(?:sk|pk|pat|ghp|gho|ghu|ghs|ghr|xox[baprs])[-_][a-z0-9_-]{8,}|akia[0-9a-z]{12,}|eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})\b/giu;

/**
 * Redacted, single-line, length-bounded text. Non-strings become "".
 *
 * The scan runs over more than `maxLength` before the final cut: redaction can
 * shorten text, and slicing to the display length first could pull an
 * unscanned secret into view.
 */
export function safeBriefText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const scanLength = Math.min(maxLength * 4, maxLength + 12_000);
  return value
    .slice(0, scanLength)
    .normalize("NFKC")
    .replace(/[\t\n\r]+/gu, " ")
    .replace(CONTROL_OR_BIDI_PATTERN, " [control removed] ")
    .replace(LINK_PATTERN, "[link redacted]")
    .replace(EMAIL_PATTERN, "[email redacted]")
    .replace(UUID_PATTERN, "[identifier redacted]")
    .replace(EXPLICIT_PROFILE_IDENTIFIER_PATTERN, "[profile identifier redacted]")
    .replace(LABELED_PROFILE_PATTERN, "[profile identifier redacted]")
    .replace(PREFIXED_PROFILE_IDENTIFIER_PATTERN, "[profile identifier redacted]")
    .replace(PHONE_PATTERN, "$1[phone redacted]")
    .replace(NAMED_CREDENTIAL_PATTERN, "$1: [credential redacted]")
    .replace(BEARER_PATTERN, "[credential redacted]")
    .replace(TOKEN_PATTERN, "[credential redacted]")
    .replace(BARE_DOMAIN_PATTERN, "[link redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

/** Up to eight redacted list items; empty items are dropped. */
export function safeBriefList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_BRIEF_INSIGHT_ITEMS)
    .map((item) => safeBriefText(item, MAX_BRIEF_LIST_ITEM_LENGTH))
    .filter((item) => item.length > 0);
}
