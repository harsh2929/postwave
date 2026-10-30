/**
 * dmarcExport — turn the report set currently on screen into something the
 * operator can hand to somebody else.
 *
 * WHY TEXT AND NOT A FILE. Compliance and support workflows regularly need
 * "send me the reports", and mobile had no path for a whole result set — only
 * single values (an archive link, a DNS record, one address). Desktop writes a
 * file via `saveFile`; `expo-file-system` is not a dependency of this app, so
 * the honest phone equivalent is the system share sheet carrying CSV TEXT.
 * That is not a downgrade in practice: the share sheet drops it straight into
 * a mail reply, a Slack message or Notes, which is where "send me the list"
 * actually ends.
 *
 * The RFC4180 quoting, the formula-injection guard and the honest-truncation
 * rule now live in `lib/csvShare`, because the suppression export needs the
 * same three and a second copy would be the one that quietly omits the guard.
 * `csvField` is re-exported here so this module's own tests and callers are
 * unchanged.
 *
 * Import-free, so the escaping rules are testable in the node vitest run.
 */
import { csvField as escape } from "@/lib/csvShare";

export { csvField } from "@/lib/csvShare";

export interface DmarcExportRow {
  domain: string;
  orgName: string;
  passCount: number;
  failCount: number;
  dateBegin: string;
  dateEnd: string;
  receivedAt: string;
  policyP?: string | undefined;
  id?: string | undefined;
}

/**
 * More than this and the share sheet is the wrong tool — the copy says so and
 * points at the export endpoint instead of pretending it fit.
 */
export const DMARC_EXPORT_MAX_ROWS = 500;

const COLUMNS = [
  "domain",
  "reporter",
  "pass",
  "fail",
  "period_start",
  "period_end",
  "received_at",
  "policy",
  "report_id",
] as const;

export interface DmarcExport {
  /** The text to hand to the share sheet. */
  body: string;
  /** Share-sheet subject line. */
  title: string;
  /** How many rows actually made it in. */
  included: number;
  /** True when rows were dropped — the caller must say so out loud. */
  truncated: boolean;
}

/**
 * Build the shareable CSV for the rows the operator is LOOKING AT — the
 * filtered set, not the whole window. Exporting something other than what is
 * on screen is the classic export bug; the caller passes `visible`.
 */
export function dmarcCsv(
  rows: readonly DmarcExportRow[],
  { windowLabel, domain }: { windowLabel: string; domain: string },
): DmarcExport {
  const included = rows.slice(0, DMARC_EXPORT_MAX_ROWS);
  const truncated = rows.length > included.length;
  const lines: string[] = [COLUMNS.join(",")];
  for (const row of included) {
    lines.push(
      [
        escape(row.domain),
        escape(row.orgName),
        escape(row.passCount),
        escape(row.failCount),
        escape(row.dateBegin),
        escape(row.dateEnd),
        escape(row.receivedAt),
        escape(row.policyP ?? ""),
        escape(row.id ?? ""),
      ].join(","),
    );
  }
  const scope = domain ? domain : "all domains";
  return {
    body: lines.join("\n"),
    title: truncated
      ? `DMARC reports — ${scope}, last ${windowLabel} (first ${included.length} of ${rows.length})`
      : `DMARC reports — ${scope}, last ${windowLabel} (${included.length})`,
    included: included.length,
    truncated,
  };
}
