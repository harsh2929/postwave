/**
 * lib/subjectLabVariants.ts — the pure half of POST /api/v1/subject-lab/variants.
 *
 * The Subject Lab could grade a subject line and never write one. Mobile does
 * generate subject lines elsewhere (SubjectLineSuggestions, inside the campaign
 * subject sheet) but that generator is unconditioned: it paraphrases the draft.
 * `/variants` is the different thing desktop and web both reach — variants
 * conditioned on an AXIS, so five results actually differ along the dimension
 * you asked about instead of being five rewordings of the same shape.
 *
 * EVERY CONSTRAINT HERE IS THE SERVER'S, COPIED FROM THE HANDLER, not guessed:
 *
 *   seed_subject  ≥ 10 characters after trimming   subject_lab.go `seed_too_short`
 *   axis          length | emoji | question | personalization   `bad_axis`
 *   count         5..8, defaulting to 6            `bad_count`
 *
 * Validating client-side is not duplication for its own sake: each of those is
 * a 400 with a code and no useful phone-sized sentence, and a Generate button
 * that can only fail is worse than one that is disabled with a reason.
 *
 * THE GATE THIS FILE DELIBERATELY DOES NOT MODEL. `/variants` is behind the
 * per-tenant `subject_lab` feature flag and is OFF by default (it is the
 * LLM-spend endpoint), answering with the shared entitlement envelope —
 * `reason: "flag"`, `remedy: "contact_workspace_admin"`. That is a server
 * fact this client cannot know in advance and must not guess: there is no
 * probe endpoint, so the honest design is to offer the control and let the
 * refusal be rendered by lib/denialEnvelope, which already has the sentence
 * for exactly that class. Pre-hiding it would tell a workspace that DOES have
 * the flag that the feature does not exist.
 *
 * Import-free (beyond nothing at all) so mobile's node vitest can exercise it.
 */

/** The four axes subject_lab.go's `validAxis` accepts. */
export const SUBJECT_LAB_AXES = [
  {
    value: "length",
    label: "Length",
    hint: "Short punchy lines against longer, more descriptive ones.",
  },
  {
    value: "emoji",
    label: "Emoji",
    hint: "With a leading emoji and without.",
  },
  {
    value: "question",
    label: "Question",
    hint: "Phrased as a question against a statement.",
  },
  {
    value: "personalization",
    label: "Personalisation",
    hint: "With a {{first_name}} or {{city}} merge tag and without.",
  },
] as const;

export type SubjectLabAxis = (typeof SUBJECT_LAB_AXES)[number]["value"];

/** subject_lab.go: `seed_subject must be ≥10 chars`. */
export const SUBJECT_LAB_SEED_MIN = 10;
/** subject_lab.go: `count must be between 5 and 8`, zero meaning 6. */
export const SUBJECT_LAB_VARIANT_MIN = 5;
export const SUBJECT_LAB_VARIANT_MAX = 8;
export const SUBJECT_LAB_VARIANT_DEFAULT = 6;

export function isSubjectLabAxis(value: unknown): value is SubjectLabAxis {
  return SUBJECT_LAB_AXES.some((axis) => axis.value === value);
}

/** True when the seed is long enough for the server to accept it. */
export function canGenerateFromSeed(raw: string | null | undefined): boolean {
  return (raw ?? "").trim().length >= SUBJECT_LAB_SEED_MIN;
}

/**
 * What to say under the field, or null when there is nothing worth saying.
 *
 * Null for an EMPTY field as well as for a valid one, and deliberately: an
 * untouched input that is already shouting a length requirement is noise, and
 * the button beside it is disabled either way. The message appears only once
 * someone has typed something the server would reject.
 */
export function subjectSeedHint(raw: string | null | undefined): string | null {
  const seed = (raw ?? "").trim();
  if (seed.length === 0 || seed.length >= SUBJECT_LAB_SEED_MIN) return null;
  return `Write at least ${SUBJECT_LAB_SEED_MIN} characters to generate from — you have ${seed.length}.`;
}

/** Clamp a requested count into the server's window. */
export function clampVariantCount(count: number | undefined): number {
  if (!count || !Number.isFinite(count)) return SUBJECT_LAB_VARIANT_DEFAULT;
  const whole = Math.round(count);
  if (whole < SUBJECT_LAB_VARIANT_MIN) return SUBJECT_LAB_VARIANT_MIN;
  if (whole > SUBJECT_LAB_VARIANT_MAX) return SUBJECT_LAB_VARIANT_MAX;
  return whole;
}

export interface SubjectVariantsReading {
  /** Trimmed, de-duplicated, blank-free. Possibly empty. */
  variants: string[];
  /** The axis the server says it generated along, or null when it said none. */
  axis: SubjectLabAxis | null;
}

/**
 * Read `variantsOutput`.
 *
 * Defensive for the same reason the scoring reader is: the composer is an LLM
 * behind two services, and "it returned six strings" is an assumption, not a
 * guarantee. Blank and duplicate lines are dropped here rather than rendered
 * as empty rows the person cannot tell apart — a duplicate would also burn one
 * of the scorer's 16 slots downstream.
 */
export function readSubjectVariants(raw: unknown): SubjectVariantsReading {
  const body = (raw ?? {}) as { variants?: unknown; axis?: unknown };
  const list = Array.isArray(body.variants) ? body.variants : [];
  const seen = new Set<string>();
  const variants: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const text = entry.trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push(text);
  }
  return {
    variants,
    axis: isSubjectLabAxis(body.axis) ? body.axis : null,
  };
}

/**
 * The seed plus its variants as scorer input — one per line, seed FIRST.
 *
 * Keeping the seed is the whole point of handing this to the scorer: the
 * question a person actually has is "is any of these better than what I
 * already wrote", and a ranking that omits the incumbent cannot answer it.
 */
export function scorableFrom(
  seed: string,
  variants: readonly string[],
): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [seed, ...variants]) {
    const text = candidate.trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(text);
  }
  return lines.join("\n");
}
