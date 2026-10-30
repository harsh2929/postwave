/**
 * smsExport — pure rules for the audited tenant-wide SMS conversations CSV
 * export.
 *
 * ROUTE: GET /api/v1/sms/conversations.csv (inbox_extras.go:69,
 * `ExportConversationsCSV`), behind the inbox's admin chain, NOT release-held.
 * The export is REASON-GATED: the server 400s without an
 * `X-Postwave-Audit-Reason` header (1..160 safe code points) and writes an
 * `sms.inbox.export` audit row. It answers with TRUTH HEADERS the client must
 * surface rather than invent:
 *   X-Postwave-Export-Limit       the row cap applied (≤ 10,000)
 *   X-Postwave-Export-As-Of       the response cutoff
 *   X-Postwave-Export-Row-Count   rows actually in the body
 *   X-Postwave-Truncated          whether the cap cut the export short
 * The parse below is the same discipline as desktop's `parseSMSExportTruth`:
 * a malformed set of headers makes the export unusable, never partially
 * trusted.
 */
export const SMS_EXPORT_REASON_MAX = 160;
export const SMS_EXPORT_MAX_BYTES = 4 * 1024 * 1024;
const FORBIDDEN = /[\p{Cc}\p{Cf}]/u;

export function smsExportReasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed === "") {
    return "An audit reason is required — it is recorded with the export.";
  }
  if (Array.from(trimmed).length > SMS_EXPORT_REASON_MAX) {
    return "Audit reasons are limited to 160 characters.";
  }
  if (FORBIDDEN.test(trimmed)) {
    return "Audit reasons cannot contain control or invisible characters.";
  }
  return null;
}

export interface SmsExportTruth {
  limit: number;
  asOf: string;
  rowCount: number;
  truncated: boolean;
}

/** Header reader shape, so this stays testable without a fetch Response. */
export interface HeaderReader {
  get(name: string): string | null;
}

export function parseSmsExportTruth(headers: HeaderReader): SmsExportTruth | null {
  const limitRaw = headers.get("X-Postwave-Export-Limit");
  const asOf = headers.get("X-Postwave-Export-As-Of");
  const rowCountRaw = headers.get("X-Postwave-Export-Row-Count");
  const truncatedRaw = headers.get("X-Postwave-Truncated");
  if (!limitRaw || !asOf || !rowCountRaw) return null;
  const limit = Number(limitRaw);
  const rowCount = Number(rowCountRaw);
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    !Number.isSafeInteger(rowCount) ||
    rowCount < 0 ||
    rowCount > limit ||
    !Number.isFinite(Date.parse(asOf)) ||
    (truncatedRaw !== "true" && truncatedRaw !== "false")
  ) {
    return null;
  }
  return { limit, asOf, rowCount, truncated: truncatedRaw === "true" };
}

/** The receipt sentence shown after a completed export. */
export function smsExportReceiptLine(truth: SmsExportTruth): string {
  return `Exported ${truth.rowCount} conversation row${truth.rowCount === 1 ? "" : "s"} at response cutoff ${truth.asOf}${
    truth.truncated
      ? ` — TRUNCATED at the ${truth.limit}-row server cap; the export is not the complete record`
      : ""
  }.`;
}
