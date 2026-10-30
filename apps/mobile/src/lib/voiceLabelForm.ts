/**
 * voiceLabelForm — the pure rules behind the voice-label trainer form.
 *
 * Kept import-free (nothing here reaches react-native) so the validation and
 * the paging arithmetic are unit-tested in the node environment rather than
 * trusted inside a component that only a simulator can run.
 */

/** Page size for the recent-labels list. */
export const VOICE_LABEL_PAGE_SIZE = 25;

export type VoiceLabelValueParse =
  | { ok: true; value: number }
  | { ok: false; message: string };

/**
 * Parse the 0..1 axis strength.
 *
 * The field is a text input (RN ships no cross-platform slider), so every
 * malformed state is reachable: empty, "0.", "1.5", "..". Each gets its own
 * sentence — "Value must be 0.0..1.0" told the user the rule but not which
 * rule they broke.
 */
export function parseVoiceLabelValue(raw: string): VoiceLabelValueParse {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, message: "Enter a strength between 0 and 1." };
  }
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value)) {
    return { ok: false, message: `"${trimmed}" isn't a number between 0 and 1.` };
  }
  if (value < 0 || value > 1) {
    return {
      ok: false,
      message: "Strength runs from 0 (absent) to 1 (strong).",
    };
  }
  return { ok: true, value };
}

/** Trimmed sample text, or null when the operator has typed nothing usable. */
export function normalizeVoiceLabelSample(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/**
 * The endpoint is absent on older gateways. 404/501 is "this deployment does
 * not have the feature"; anything else is a fault and must stay a fault.
 */
export function voiceLabelsUnavailable(status: number | undefined): boolean {
  return status === 404 || status === 501;
}

export interface VoiceLabelPageSummary {
  /** Rows currently rendered. */
  shown: number;
  /** Server-reported row count for the tenant, when it sent one. */
  total: number | null;
  /** True when the server says there are rows we have not asked for. */
  hasMore: boolean;
  /** Caption that never claims a total the server did not report. */
  caption: string;
}

/**
 * Describe the visible slice.
 *
 * The list was hard-capped at 25 with the server's own `total` thrown away, so
 * a workspace with 300 labels showed 25 rows and said nothing at all about the
 * other 275. Silence about truncation is the failure this whole audit keeps
 * finding; state the ratio and offer the next page.
 */
export function voiceLabelPageSummary(
  shown: number,
  total: unknown,
): VoiceLabelPageSummary {
  const reported =
    typeof total === "number" && Number.isFinite(total) && total >= 0
      ? Math.floor(total)
      : null;
  const safeShown = Math.max(0, Math.floor(shown));
  if (reported === null) {
    return {
      shown: safeShown,
      total: null,
      hasMore: false,
      caption: `${safeShown} loaded`,
    };
  }
  return {
    shown: safeShown,
    total: reported,
    hasMore: safeShown < reported,
    caption: `${safeShown} of ${reported}`,
  };
}
