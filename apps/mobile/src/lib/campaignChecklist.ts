/**
 * lib/campaignChecklist.ts — the wire shape and the pure reading of
 * GET /api/v1/campaigns/{id}/checklist.
 *
 * The backend already computes six pre-send gates and a single `ready`
 * boolean (apps/api/internal/campaigns/checklist.go — from_address_verified,
 * subject_set, body_non_empty, list_selected, recipient_count_above_zero,
 * unsubscribe_link_present). Desktop mounts them for every draft; mobile sent
 * blind. Sending to a whole list from a phone with no verification is the
 * highest-consequence unguarded action in the app.
 *
 * `ready` is trusted when present, but recomputed defensively when a
 * deployment omits it — a missing boolean must never read as "ready".
 */

export type ChecklistStatus = "pass" | "warn" | "fail";

export interface ChecklistItem {
  key: string;
  label: string;
  status: ChecklistStatus;
  detail: string;
}

export interface ChecklistResponse {
  campaign_id?: string;
  ready?: boolean;
  checks?: ChecklistItem[];
}

export interface ChecklistSummary {
  /** Safe to send without an override. */
  ready: boolean;
  items: ChecklistItem[];
  passCount: number;
  warnCount: number;
  failCount: number;
  /** Labels of the failing gates, for the confirm sheet's consequence line. */
  blockingLabels: string[];
  /** One-line headline for the card. */
  headline: string;
}

function normalizeStatus(raw: unknown): ChecklistStatus {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "pass" || s === "warn" || s === "fail") return s;
  // An unrecognised status is treated as a warning: it is not proof of a
  // problem, but it is definitely not proof of a pass.
  return "warn";
}

/** Coerce an arbitrary wire payload into well-formed checklist items. */
export function normalizeChecklist(raw: unknown): ChecklistItem[] {
  const checks = (raw as ChecklistResponse | null | undefined)?.checks;
  if (!Array.isArray(checks)) return [];
  const out: ChecklistItem[] = [];
  for (const entry of checks) {
    if (!entry || typeof entry !== "object") continue;
    const key = typeof entry.key === "string" ? entry.key : "";
    const label =
      typeof entry.label === "string" && entry.label.trim().length > 0
        ? entry.label
        : key || "Check";
    out.push({
      key: key || label,
      label,
      status: normalizeStatus(entry.status),
      detail: typeof entry.detail === "string" ? entry.detail : "",
    });
  }
  return out;
}

/** Tone token for a check row's pill. */
export function checklistTone(
  status: ChecklistStatus,
): "success" | "warning" | "danger" {
  if (status === "pass") return "success";
  if (status === "fail") return "danger";
  return "warning";
}

/**
 * A short glyph that carries the same information as the colour, so a
 * colour-blind operator (or a screen reader) does not depend on the pill hue.
 */
export function checklistGlyph(status: ChecklistStatus): string {
  if (status === "pass") return "✓";
  if (status === "fail") return "✕";
  return "!";
}

export function summarizeChecklist(raw: unknown): ChecklistSummary {
  const items = normalizeChecklist(raw);
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;
  const blockingLabels: string[] = [];
  for (const item of items) {
    if (item.status === "pass") passCount += 1;
    else if (item.status === "fail") {
      failCount += 1;
      blockingLabels.push(item.label);
    } else warnCount += 1;
  }

  const declaredReady = (raw as ChecklistResponse | null | undefined)?.ready;
  // Trust the server's boolean only when it agrees there are no failures;
  // a `ready: true` alongside a failing gate is a bug we must not amplify.
  const ready =
    items.length === 0
      ? declaredReady === true
      : failCount === 0 && declaredReady !== false;

  const headline =
    items.length === 0
      ? "Pre-send checks are unavailable for this campaign."
      : failCount > 0
        ? `${failCount} check${failCount === 1 ? "" : "s"} failed`
        : warnCount > 0
          ? `Ready to send · ${warnCount} warning${warnCount === 1 ? "" : "s"}`
          : "All pre-send checks passed";

  return {
    ready,
    items,
    passCount,
    warnCount,
    failCount,
    blockingLabels,
    headline,
  };
}
