/**
 * lib/campaignExport.ts — "send this list to myself" from a phone.
 *
 * Desktop builds a CSV in the browser and hands it to a download
 * (apps/desktop/src/pages/campaigns/useCampaignBulkActions.ts). A phone has no
 * download folder worth the name, and this app has no filesystem or document
 * dependency installed (`expo-file-system`/`expo-sharing` are NOT in
 * package.json — see the note in the round report), so the honest mobile form
 * of the same act is TEXT: CSV rows into the clipboard, or into the system
 * share sheet, where Mail / Notes / Slack are one tap away and every one of
 * them accepts pasted CSV.
 *
 * Two things this deliberately does NOT do:
 *
 *   - It does not export the whole workspace. It exports what the operator is
 *     looking at — the filtered, loaded rows, or the current selection — and
 *     `campaignExportCaveat` states which, because a file called
 *     "campaigns.csv" holding 100 of 900 rows is worse than no file.
 *   - It does not print 0 for a rate the server never sent. An absent
 *     measurement is an EMPTY CELL, so a spreadsheet's AVERAGE() does not
 *     silently include campaigns that have no data.
 */

export interface ExportableCampaign {
  id: string;
  name?: string | undefined;
  subject?: string | undefined;
  status?: string | undefined;
  scheduled_at?: string | null | undefined;
  sent_at?: string | null | undefined;
  created_at?: string | undefined;
  /** 0..1 fractions — see the scale map in lib/campaignFormat. */
  open_rate?: number | undefined;
  click_rate?: number | undefined;
}

export const CAMPAIGN_EXPORT_COLUMNS = [
  "id",
  "name",
  "subject",
  "status",
  "scheduled_at",
  "sent_at",
  "created_at",
  "open_rate_pct",
  "click_rate_pct",
] as const;

/**
 * RFC-4180 field escaping.
 *
 * The leading-character guard is the same one the Go exporter applies
 * (analytics/handlers.go `sanitizeCSVCell`): a cell starting `=`, `+`, `-` or
 * `@` is executed as a formula by Excel and Numbers, so a campaign someone
 * named "=cmd|..." would run on open. Prefixing an apostrophe neutralises it
 * without changing what a human reads.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  const first = text.trimStart().charAt(0);
  if (first === "=" || first === "+" || first === "-" || first === "@") {
    text = `'${text}`;
  }
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** A rate as a percent with one decimal, or "" when it was never measured. */
function ratePctCell(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return (Math.max(0, Math.min(1, value)) * 100).toFixed(1);
}

/** The rows as CSV, header included. Newline-terminated per RFC 4180. */
export function campaignsToCsv(rows: readonly ExportableCampaign[]): string {
  const lines = [CAMPAIGN_EXPORT_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvCell(row.id),
        csvCell(row.name ?? ""),
        csvCell(row.subject ?? ""),
        csvCell(row.status ?? ""),
        csvCell(row.scheduled_at ?? ""),
        csvCell(row.sent_at ?? ""),
        csvCell(row.created_at ?? ""),
        ratePctCell(row.open_rate),
        ratePctCell(row.click_rate),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export interface CampaignExportScope {
  /** How many rows the export contains. */
  exported: number;
  /** True when the list still has unfetched pages behind it. */
  moreAvailable: boolean;
  /** True when the export is a hand-picked selection, not the whole view. */
  selection: boolean;
  /** The active search term, if any. */
  query?: string | undefined;
  /** The active status bucket label, if it is not "all". */
  filterLabel?: string | undefined;
}

/**
 * One line naming exactly what is in the export — pasted above the CSV and
 * spoken by the confirmation toast.
 *
 * This is the honesty guard for the whole feature: exporting the loaded
 * window of an infinite list and calling the result "campaigns" would let
 * someone average 100 rows and report it as a workspace figure.
 */
export function campaignExportCaveat(scope: CampaignExportScope): string {
  const noun = scope.exported === 1 ? "campaign" : "campaigns";
  if (scope.selection) {
    return `${scope.exported} selected ${noun}.`;
  }
  const parts: string[] = [];
  if (scope.filterLabel) parts.push(scope.filterLabel.toLowerCase());
  if (scope.query?.trim()) parts.push(`matching "${scope.query.trim()}"`);
  const qualifier = parts.length > 0 ? ` ${parts.join(", ")}` : "";
  const tail = scope.moreAvailable
    ? " — the rows loaded so far, not the whole workspace. Scroll further, or export on the web app, for the complete set."
    : ".";
  return `${scope.exported}${qualifier} ${noun}${tail}`;
}

/** The full clipboard/share payload: the caveat line, then the CSV. */
export function campaignExportText(
  rows: readonly ExportableCampaign[],
  scope: CampaignExportScope,
): string {
  return `# ${campaignExportCaveat(scope)}\r\n${campaignsToCsv(rows)}`;
}
