/**
 * lib/featureFlagOverrides.ts — the pure half of AUTHORING a feature-flag
 * override from a phone: the draft, its validation, the upsert body and the
 * sentence a removal is confirmed with.
 *
 * lib/platformConfig.ts owns the READ shape (FeatureFlagView) and recorded
 * that writes stayed on the web admin because "a mis-tapped feature flag
 * changes what every colleague sees". The parity register (docs/mobile-
 * desktop-parity-2026-08-28.md, "Feature-flag override authoring") judged
 * that a validated form with the key shown verbatim is not a mis-tap, and a
 * removal behind a confirm is not either.
 *
 * WIRE FACTS, read off apps/api/internal/feature_flags/feature_flags.go:
 *
 *   POST   /api/v1/feature-flags        (admin) body {key, value, note}
 *          key and value: 1..200 chars after trimming, else 400 bad_key /
 *          bad_value (:141–149); note is NULLIF'd when empty. ON CONFLICT
 *          updates value and note — the same call creates and edits.
 *          Answers {id, key, value}.
 *   DELETE /api/v1/feature-flags/{key}  (admin) removes ONLY this workspace's
 *          override (tenant_id = $1); 404 when none exists; 204 on success.
 *          The platform default is never touched.
 *
 * Import-free so it runs under node vitest.
 */
import type { FeatureFlagView } from "./platformConfig";

export interface FlagDraft {
  key: string;
  value: string;
  note: string;
}

/** The server's caps (feature_flags.go:142, :147). */
export const FLAG_KEY_MAX = 200;
export const FLAG_VALUE_MAX = 200;

export function emptyFlagDraft(): FlagDraft {
  return { key: "", value: "", note: "" };
}

/**
 * The draft an existing row opens with. The value is copied whether the row
 * is an override or a platform default — a new override usually starts from
 * the current value. The note is copied ONLY from an override: a platform
 * default's note is the platform's reason, and pre-filling it would attach
 * that reason to a workspace decision it was never written for.
 */
export function flagDraftFromRow(flag: FeatureFlagView): FlagDraft {
  return {
    key: flag.key,
    value: flag.value,
    note: flag.isDefault ? "" : flag.note,
  };
}

export interface FlagDraftErrors {
  key?: string;
  value?: string;
}

/**
 * Mirror of the server's checks, plus one of its own: a key containing
 * whitespace is accepted by POST but cannot be addressed by DELETE /{key}
 * without an encoding round-trip nobody wants to debug, so it is refused
 * here. Returns null when the draft can be sent.
 */
export function validateFlagDraft(draft: FlagDraft): FlagDraftErrors | null {
  const errors: FlagDraftErrors = {};
  const key = draft.key.trim();
  if (!key) errors.key = "Flag key is required.";
  else if (/\s/.test(key)) errors.key = "Flag key can’t contain spaces.";
  else if (key.length > FLAG_KEY_MAX) {
    errors.key = `Flag key is too long (max ${FLAG_KEY_MAX} characters).`;
  }
  const value = draft.value.trim();
  if (!value) {
    errors.value = "A value is required — “on” or “off” for a simple switch.";
  } else if (value.length > FLAG_VALUE_MAX) {
    errors.value = `Value is too long (max ${FLAG_VALUE_MAX} characters).`;
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

export interface FlagUpsertBody {
  key: string;
  value: string;
  note: string;
}

/** The POST body, trimmed the way the server trims it. */
export function flagUpsertBody(draft: FlagDraft): FlagUpsertBody {
  return {
    key: draft.key.trim(),
    value: draft.value.trim(),
    note: draft.note.trim(),
  };
}

/** True once any field differs from what the sheet opened with. */
export function flagDraftDirty(draft: FlagDraft, initial: FlagDraft): boolean {
  return (
    draft.key.trim() !== initial.key.trim() ||
    draft.value.trim() !== initial.value.trim() ||
    draft.note.trim() !== initial.note.trim()
  );
}

/**
 * What removing an override does — desktop's ConfirmModal sentence, kept
 * word-for-word so both clients describe one server behaviour identically.
 */
export function overrideRemovalConsequence(key: string): string {
  return `"${key}" falls back to its platform default (or to missing if no default exists). The default row is untouched.`;
}

/** The one-line explanation under the form for a row that is a platform default. */
export const DEFAULT_ROW_NOTE =
  "Saving creates a workspace override. The platform default stays as it is and applies again if the override is removed.";
