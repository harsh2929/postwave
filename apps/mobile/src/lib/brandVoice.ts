/**
 * lib/brandVoice.ts — pure policy for the operator-AUTHORED brand voice.
 *
 * Two different things are called "voice" in this product and conflating them
 * is the mistake this module exists to prevent:
 *
 *   - `/api/v1/voice/profile`       — the MEASURED corpus. Moosewave derives it
 *                                     from what the workspace has already
 *                                     sent. Nobody writes it by hand.
 *   - `/api/v1/voice/brand-profile` — the AUTHORED profile. Descriptors,
 *                                     writing rules and sample snippets an
 *                                     operator typed. It is an instruction to
 *                                     the AI, not an observation about it.
 *
 * A screen that shows only the first tells an operator their voice is
 * "measured, warm, direct" while quietly ignoring the rule they wrote saying
 * "never use exclamation marks".
 *
 * Import-free by design (house rule: vitest runs in a node environment), so
 * the caps and the parser are directly unit-testable.
 *
 * Caps mirror apps/api/internal/brand_voice/brand_voice.go:62-68 exactly. They
 * are duplicated rather than fetched because the server rejects with a 422 and
 * a bare field message; catching it client-side means the operator finds out
 * before losing the sheet's contents.
 */

export const BRAND_VOICE_CAPS = {
  descriptors: 20,
  descriptorChars: 64,
  writingRules: 30,
  ruleChars: 512,
  sampleSnippets: 10,
  snippetChars: 4096,
} as const;

/** Wire row from GET /api/v1/voice/brand-profile (brand_voice.Profile). */
export interface BrandVoiceProfileWire {
  id?: string;
  descriptors?: string[] | null;
  writing_rules?: string[] | null;
  sample_snippets?: string[] | null;
  is_active?: boolean;
  extracted_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** Normalised, always-defined view the card renders from. */
export interface BrandVoiceProfile {
  id: string;
  descriptors: string[];
  writingRules: string[];
  sampleSnippets: string[];
  /** True when the operator has authored nothing at all. */
  empty: boolean;
  updatedAt: string | null;
}

function cleanList(
  values: readonly unknown[] | null | undefined,
  maxChars: number,
  maxItems: number,
): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    out.push(trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function normalizeBrandVoiceProfile(
  wire: BrandVoiceProfileWire | null | undefined,
): BrandVoiceProfile | null {
  if (!wire) return null;
  const descriptors = cleanList(
    wire.descriptors,
    BRAND_VOICE_CAPS.descriptorChars,
    BRAND_VOICE_CAPS.descriptors,
  );
  const writingRules = cleanList(
    wire.writing_rules,
    BRAND_VOICE_CAPS.ruleChars,
    BRAND_VOICE_CAPS.writingRules,
  );
  const sampleSnippets = cleanList(
    wire.sample_snippets,
    BRAND_VOICE_CAPS.snippetChars,
    BRAND_VOICE_CAPS.sampleSnippets,
  );
  return {
    id: typeof wire.id === "string" ? wire.id : "",
    descriptors,
    writingRules,
    sampleSnippets,
    empty:
      descriptors.length === 0 &&
      writingRules.length === 0 &&
      sampleSnippets.length === 0,
    updatedAt: typeof wire.updated_at === "string" ? wire.updated_at : null,
  };
}

/**
 * One line per entry is the only editing gesture that works on a phone
 * keyboard — a per-row add/remove list costs a tap per item and a modal per
 * edit. Blank lines are dropped rather than stored, matching `clean()` on the
 * server so the round trip is idempotent.
 */
export function parseLineList(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function toLineList(values: readonly string[]): string {
  return values.join("\n");
}

export interface BrandVoiceDraft {
  descriptors: string[];
  writingRules: string[];
}

/**
 * Client-side mirror of brand_voice.validate(). Returns a human message, or
 * null when the draft is acceptable. Naming the offending line is the whole
 * point — "validation_failed" from the server does not tell an operator which
 * of their 30 rules was too long.
 */
export function brandVoiceDraftError(draft: BrandVoiceDraft): string | null {
  if (draft.descriptors.length > BRAND_VOICE_CAPS.descriptors) {
    return `Up to ${BRAND_VOICE_CAPS.descriptors} descriptors. Remove ${draft.descriptors.length - BRAND_VOICE_CAPS.descriptors}.`;
  }
  if (draft.writingRules.length > BRAND_VOICE_CAPS.writingRules) {
    return `Up to ${BRAND_VOICE_CAPS.writingRules} writing rules. Remove ${draft.writingRules.length - BRAND_VOICE_CAPS.writingRules}.`;
  }
  const longDescriptor = draft.descriptors.findIndex(
    (d) => d.length > BRAND_VOICE_CAPS.descriptorChars,
  );
  if (longDescriptor !== -1) {
    return `Descriptor ${longDescriptor + 1} is longer than ${BRAND_VOICE_CAPS.descriptorChars} characters.`;
  }
  const longRule = draft.writingRules.findIndex(
    (r) => r.length > BRAND_VOICE_CAPS.ruleChars,
  );
  if (longRule !== -1) {
    return `Writing rule ${longRule + 1} is longer than ${BRAND_VOICE_CAPS.ruleChars} characters.`;
  }
  return null;
}

/**
 * Message for a failed read/write. 404 is NOT an error here — the server
 * returns it for "this tenant has authored nothing yet", which is a
 * legitimate empty state, so the caller maps it to null before reaching this.
 */
export function brandVoiceErrorMessage(status: number, fallback: string): string {
  if (status === 403) {
    return "Your role can't change the authored brand voice. Ask an admin.";
  }
  if (status === 422 || status === 400) {
    return fallback || "Some entries were rejected. Shorten them and retry.";
  }
  if (status === 405 || status === 501) {
    return "This deployment doesn't expose an authored brand voice.";
  }
  if (status === 503) {
    return "The brand-voice service is unavailable right now.";
  }
  return fallback || "Couldn't save the authored brand voice.";
}
