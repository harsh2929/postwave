/**
 * lib/campaignA11y.ts — the accessibility pre-send check.
 *
 * POST /api/v1/a11y/check (apps/api/internal/a11y/a11y.go) runs the WCAG
 * heuristic ruleset over {html, subject} and answers a Report:
 * {findings: [{rule, severity, message, snippet, wcag}], counts, score}.
 * Session floor is ADMIN in the routeauth manifest, which is why the card is
 * offered to admins only. Desktop shows the row in its SendChecklist; on the
 * phone it joins the send confirmation as an opt-in check card.
 */

export type A11ySeverity = "info" | "warn" | "error";

export interface A11yFindingRow {
  key: string;
  rule: string;
  severity: A11ySeverity;
  message: string;
  wcag: string;
}

export interface A11yReading {
  score: number;
  counts: { info: number; warn: number; error: number };
  findings: A11yFindingRow[];
  truncated: boolean;
}

/** Findings shown inline; a wall of 40 rows is not a phone surface. */
export const A11Y_FINDINGS_SHOWN = 8;

export function readA11yReport(data: unknown): A11yReading | null {
  if (!data || typeof data !== "object") return null;
  const body = data as {
    score?: unknown;
    counts?: unknown;
    findings?: unknown;
  };
  if (typeof body.score !== "number" || !Number.isFinite(body.score)) {
    return null;
  }
  const countsRaw =
    body.counts && typeof body.counts === "object"
      ? (body.counts as Record<string, unknown>)
      : {};
  const count = (v: unknown): number =>
    typeof v === "number" && v >= 0 ? v : 0;
  const findings: A11yFindingRow[] = [];
  const raw = Array.isArray(body.findings) ? body.findings : [];
  for (const [index, item] of raw.entries()) {
    if (findings.length >= A11Y_FINDINGS_SHOWN) break;
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const message = typeof row.message === "string" ? row.message : "";
    if (!message) continue;
    const severity =
      row.severity === "error" || row.severity === "warn" ? row.severity : "info";
    const rule = typeof row.rule === "string" ? row.rule : `finding-${index}`;
    findings.push({
      key: `${index}:${rule}`,
      rule,
      severity,
      message,
      wcag: typeof row.wcag === "string" ? row.wcag : "",
    });
  }
  return {
    score: Math.max(0, Math.min(100, Math.round(body.score))),
    counts: {
      info: count(countsRaw.info),
      warn: count(countsRaw.warn),
      error: count(countsRaw.error),
    },
    findings,
    truncated: raw.length > findings.length,
  };
}

export function a11yHeadline(reading: A11yReading): string {
  const parts: string[] = [];
  if (reading.counts.error > 0) {
    parts.push(
      `${reading.counts.error} error${reading.counts.error === 1 ? "" : "s"}`,
    );
  }
  if (reading.counts.warn > 0) {
    parts.push(
      `${reading.counts.warn} warning${reading.counts.warn === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 0) {
    return `Accessibility ${reading.score}/100 — no blocking findings.`;
  }
  return `Accessibility ${reading.score}/100 — ${parts.join(", ")}.`;
}

export function a11yTone(
  reading: A11yReading,
): "success" | "warning" | "danger" {
  if (reading.counts.error > 0) return "danger";
  if (reading.counts.warn > 0) return "warning";
  return "success";
}
