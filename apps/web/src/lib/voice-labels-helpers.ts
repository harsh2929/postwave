// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure helpers for the voice-labels admin surface: coverage/ distribution
// summaries (SEQ-048) and bulk-import parsing (SEQ-049). Kept dependency-free
// so they are synchronously unit-testable and reusable across the form/list.

import {
  VOICE_LABEL_AXES,
  type VoiceLabel,
  type VoiceLabelAxis,
  type VoiceLabelInput,
} from "./voice-labels-api";

// ----- Coverage summary (SEQ-048) ----------------------------------------

/** Five equal buckets across the 0.00–1.00 axis, for a compact histogram. */
export const LABEL_VALUE_BUCKETS = [
  { label: "0.0–0.2", min: 0, max: 0.2 },
  { label: "0.2–0.4", min: 0.2, max: 0.4 },
  { label: "0.4–0.6", min: 0.4, max: 0.6 },
  { label: "0.6–0.8", min: 0.6, max: 0.8 },
  { label: "0.8–1.0", min: 0.8, max: 1.0001 },
] as const;

export interface AxisCoverage {
  axis: VoiceLabelAxis;
  count: number;
  /** Count per LABEL_VALUE_BUCKETS bucket, same order/length. */
  buckets: number[];
}

export interface LabelCoverage {
  total: number;
  perAxis: AxisCoverage[];
}

function bucketIndex(value: number): number {
  for (let i = 0; i < LABEL_VALUE_BUCKETS.length; i += 1) {
    const b = LABEL_VALUE_BUCKETS[i];
    if (value >= b.min && value < b.max) return i;
  }
  // Clamp out-of-range values into the nearest edge bucket.
  return value < 0 ? 0 : LABEL_VALUE_BUCKETS.length - 1;
}

/**
 * Summarize labels into per-axis counts and a value-distribution histogram so
 * labelers can see coverage gaps and balance across axes at a glance.
 */
export function summarizeLabelCoverage(
  labels: readonly VoiceLabel[],
): LabelCoverage {
  const perAxis: AxisCoverage[] = VOICE_LABEL_AXES.map((axis) => ({
    axis,
    count: 0,
    buckets: LABEL_VALUE_BUCKETS.map(() => 0),
  }));
  const byAxis = new Map(perAxis.map((entry) => [entry.axis, entry]));
  for (const label of labels) {
    const entry = byAxis.get(label.axis);
    if (!entry) continue;
    entry.count += 1;
    entry.buckets[bucketIndex(label.value)] += 1;
  }
  return { total: labels.length, perAxis };
}

// ----- Bulk import (SEQ-049) ---------------------------------------------

export interface LabelImportResult {
  valid: VoiceLabelInput[];
  errors: string[];
}

function isAxis(value: unknown): value is VoiceLabelAxis {
  return (
    typeof value === "string" &&
    (VOICE_LABEL_AXES as readonly string[]).includes(value)
  );
}

/**
 * Parse a JSON string (from the export.json format or a hand-authored array)
 * into validated label inputs. Every row is checked; malformed rows are
 * reported with a 1-based index rather than silently dropped, so a partial
 * corpus never imports with hidden gaps.
 */
export function parseLabelImport(text: string): LabelImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { valid: [], errors: ["File is not valid JSON."] };
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { items?: unknown })?.items)
      ? (parsed as { items: unknown[] }).items
      : null;
  if (!rows) {
    return {
      valid: [],
      errors: ["Expected a JSON array of labels (or an { items: [...] } object)."],
    };
  }

  const valid: VoiceLabelInput[] = [];
  const errors: string[] = [];
  rows.forEach((raw, index) => {
    const at = `Row ${index + 1}`;
    if (!raw || typeof raw !== "object") {
      errors.push(`${at}: not an object.`);
      return;
    }
    const record = raw as Record<string, unknown>;
    const sampleText = record.sample_text;
    if (typeof sampleText !== "string" || sampleText.trim() === "") {
      errors.push(`${at}: missing sample_text.`);
      return;
    }
    if (!isAxis(record.axis)) {
      errors.push(
        `${at}: axis must be one of ${VOICE_LABEL_AXES.join(", ")}.`,
      );
      return;
    }
    const value = Number(record.value);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(`${at}: value must be a number between 0 and 1.`);
      return;
    }
    const notes =
      typeof record.notes === "string" && record.notes.trim() !== ""
        ? record.notes.trim()
        : undefined;
    valid.push({
      sample_text: sampleText.trim(),
      axis: record.axis,
      value: Number(value.toFixed(2)),
      ...(notes ? { notes } : {}),
    });
  });

  return { valid, errors };
}
