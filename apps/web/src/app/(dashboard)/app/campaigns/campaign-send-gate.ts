// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure gating logic for the campaign Send confirmation. Sending is IRREVERSIBLE,
// so this is deliberately conservative and unit-tested (audit CAMP-002/011):
// Send stays disabled while the recipient count or the pre-send checklist are
// still loading, whenever the checklist has a failing gate, and — if the
// recipient-count preview itself errored — until the user explicitly
// acknowledges sending without a verified count. Kept React-free so it can be
// tested without importing the dialog's UI dependencies.

export interface SendGateFlags {
  /** A send request is already in flight. */
  sending: boolean;
  /** The recipient-count preview is still loading. */
  countPending: boolean;
  /** The recipient-count preview failed to load. */
  countErrored: boolean;
  /** The pre-send checklist is still loading. */
  checklistPending: boolean;
  /** The pre-send checklist resolved with at least one failing/blocking gate. */
  checklistBlocks: boolean;
  /** User explicitly acknowledged sending without a verified count. */
  ackNoCount: boolean;
}

export function sendGateDisabled(f: SendGateFlags): boolean {
  return (
    f.sending ||
    f.countPending ||
    f.checklistPending ||
    f.checklistBlocks ||
    (f.countErrored && !f.ackNoCount)
  );
}

/* ------------------------------------------------------------------ *
 * Client-side gate rows: accessibility and broken links.
 *
 * Parity rows campaigns-31 and campaigns-32. Desktop runs both alongside the
 * server checklist in apps/desktop/src/components/SendChecklist.tsx and
 * grades them with the SAME pass/warn/fail vocabulary the server checklist
 * uses, so the two sets of rows read as one list.
 *
 * THEY ARE ADVISORY, NOT BLOCKING — deliberately, and the same way desktop
 * has them. `sendGateDisabled` above is the gate, and it is fed only by the
 * SERVER checklist's `ready`. A link-checker that cannot reach a URL from our
 * network, or a contrast heuristic that dislikes a brand colour, must not be
 * able to stop a send the server cleared. Adding either to `SendGateFlags`
 * would silently promote a heuristic into a veto.
 *
 * Kept React-free next to the gate it accompanies, so the grading can be
 * tested without mounting the dialog.
 * ------------------------------------------------------------------ */

/** Same three-way vocabulary as the server checklist's `ChecklistStatus`. */
export type SendCheckRowStatus = "pass" | "warn" | "fail";

/** Minimal shape of `POST /api/v1/a11y/check` this grading reads. */
export interface A11yRowReport {
  counts: Record<string, number>;
  score: number;
  findings: unknown[];
}

/** Minimal shape of one `POST /api/v1/campaigns/{id}/check-links` verdict. */
export interface LinkRowResult {
  url: string;
  status: number;
  ok: boolean;
  error?: string;
}

function count(counts: Record<string, number>, key: string): number {
  const value = counts[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** WCAG errors fail the row, warnings warn it, anything else passes. */
export function a11yRowStatus(report: A11yRowReport): SendCheckRowStatus {
  if (count(report.counts, "error") > 0) return "fail";
  if (count(report.counts, "warn") > 0) return "warn";
  return "pass";
}

export function a11yRowDetail(report: A11yRowReport): string {
  const errors = count(report.counts, "error");
  const warnings = count(report.counts, "warn");
  const info = count(report.counts, "info");
  const parts = [`Score ${Math.round(report.score)}/100`];
  if (errors > 0) parts.push(plural(errors, "error"));
  if (warnings > 0) parts.push(plural(warnings, "warning"));
  if (errors === 0 && warnings === 0) {
    parts.push(info > 0 ? plural(info, "info note") : "no findings");
  }
  return parts.join(" · ");
}

/**
 * Any unreachable link fails the row.
 *
 * An EMPTY result is a pass, but never with wording that implies links were
 * verified — the sweep only sees absolute hrefs in the last SAVED body, so
 * "no links found" and "every link is reachable" are different sentences and
 * `a11yRowDetail`'s sibling below keeps them different.
 */
export function linkRowStatus(results: LinkRowResult[]): SendCheckRowStatus {
  return results.some((row) => !row.ok) ? "fail" : "pass";
}

export function linkRowDetail(results: LinkRowResult[]): string {
  if (results.length === 0) {
    return "No links found in the saved body — nothing was checked.";
  }
  const broken = results.filter((row) => !row.ok).length;
  if (broken === 0) {
    return `${plural(results.length, "link")} checked — all reachable.`;
  }
  return `${broken.toLocaleString()} of ${plural(results.length, "link")} broken.`;
}

/**
 * What to show in a link row's status column: the code, or that none came
 * back. The reason itself (`error`, a sentence the server writes for the
 * sender) is shown beside the link, not squeezed into this column.
 */
export function linkStatusLabel(row: LinkRowResult): string {
  if (row.status > 0) return String(row.status);
  return row.error ? "No response" : "—";
}
