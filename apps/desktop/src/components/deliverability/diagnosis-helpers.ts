/**
 * diagnosis-helpers — pure logic behind the DiagnosticianCard (#44,
 * proxied POST /api/v1/diagnose/{campaign_id}).
 *
 * The service returns `{campaign_id, diagnosis (markdown), fixes[],
 * predicted_impact, generated_at}`. The diagnosis markdown MAY carry
 * `## ` section headings (placement analysis, reputation assessment,
 * engagement patterns, …) when the calibrated prompt is loaded, or be
 * a single sentence from the stub prompt — the splitter handles both
 * so the card renders readable sections either way.
 */

import type { DiagnosisFix } from "../../lib/api-client";

export interface DiagnosisSection {
  /** Empty string for the preamble / single-blob case. */
  heading: string;
  body: string;
}

/**
 * Splits diagnosis markdown on `## `/`### ` headings. Content before
 * the first heading becomes a heading-less preamble section. A
 * heading-free document yields one section. Blank-only input → [].
 */
export function splitDiagnosisSections(markdown: string): DiagnosisSection[] {
  const text = (markdown ?? "").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const sections: DiagnosisSection[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = (): void => {
    const body = buf.join("\n").trim();
    if (body || heading) sections.push({ heading, body });
    buf = [];
  };
  for (const line of lines) {
    const m = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      heading = m[1] ?? "";
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Fixes ranked by estimated impact (desc) — the operator should see
 * the biggest win first. Pure; ties keep the server order.
 */
export function sortFixesByImpact(fixes: DiagnosisFix[]): DiagnosisFix[] {
  return [...fixes].sort(
    (a, b) => (b.estimated_impact ?? 0) - (a.estimated_impact ?? 0),
  );
}

/** 0.12 → "+12%" added inbox-rate; 0/invalid → "—" (don't promise). */
export function formatImpact(fraction: number | null | undefined): string {
  if (fraction == null || Number.isNaN(fraction) || fraction <= 0) return "—";
  const pct = fraction * 100;
  const rounded = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return `+${rounded}%`;
}

export const FIX_ACTION_LABELS: Readonly<Record<string, string>> = {
  dns_record: "DNS record",
  copy_change: "Copy change",
  image_swap: "Image swap",
  resend: "Resend",
};

export function fixActionLabel(action: string): string {
  return FIX_ACTION_LABELS[action] ?? action;
}

/** predicted_impact map → ordered rows (largest first), keys humanized. */
export function predictedImpactRows(
  impact: Record<string, number> | null | undefined,
): Array<{ key: string; label: string; value: string }> {
  if (!impact) return [];
  return Object.entries(impact)
    .sort((a, b) => b[1] - a[1])
    .map(([key, v]) => ({
      key,
      label: key.replace(/_/g, " "),
      value: formatImpact(v),
    }));
}
