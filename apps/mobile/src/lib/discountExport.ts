/**
 * discountExport — "send me everyone who used this code", from a phone.
 *
 * The expanded drawer on the Discounts screen shows the newest redemptions
 * and says so, which is honest but terminal: a code redeemed 400 times has no
 * path from mobile to the other 390. The API already streams the whole set —
 * `GET /api/v1/discounts/{code}/redemptions.csv`
 * (apps/api/internal/discounts/handlers.go:41, handler at :158) returns
 * `text/csv` under `RequireScope(ScopeReadReports)`, a read-only scope, so on
 * the session path any authenticated dashboard user may fetch it.
 *
 * WHY THE SERVER'S CSV IS RE-EMITTED RATHER THAN FORWARDED. `ExportRedemptions`
 * writes rows with `encoding/csv`, which quotes per RFC4180 but does NOT
 * neutralise a leading `=`, `+`, `-` or `@` — Excel and Sheets EXECUTE those.
 * The subscriber email in each row is customer-supplied and a local part
 * legitimately begins with `+`, so a forwarded export pastes attacker-chosen
 * formulas into whichever spreadsheet finance opens it in. The text is parsed
 * with `parseCsvRows` and re-emitted through `csvField`, which neutralises
 * them. This is the same treatment `suppressionExport` applies for the same
 * reason.
 *
 * WHY IT IS CAPPED. A share sheet is not a file: iOS silently mangles very
 * large text payloads and `expo-file-system` is not a dependency of this app,
 * so a file URL is unavailable. The endpoint's own ceiling is 10,000 rows and
 * takes no `limit` parameter, so the cap is applied here — and stated in the
 * title and in the toast, so a partial export is never mistaken for the whole
 * list.
 *
 * Import-free apart from `csvShare` (itself import-free), so every rule here
 * is testable in the node vitest run.
 */
import { csvField, parseCsvRows } from "@/lib/csvShare";

/** Rows kept for the share sheet. The endpoint itself streams up to 10,000. */
export const DISCOUNT_EXPORT_MAX_ROWS = 500;

/** The server's column order, preserved so the export matches the web one. */
const COLUMNS = ["subscriber_email", "subscriber_id", "redeemed_at"] as const;

export function discountRedemptionsCsvPath(code: string): string {
  return `/api/v1/discounts/${encodeURIComponent(code)}/redemptions.csv`;
}

export interface DiscountExport {
  /** The text to hand to the share sheet. */
  body: string;
  /** Share-sheet subject line. */
  title: string;
  /** Data rows (header excluded) that made it in. */
  included: number;
  /** True when rows were dropped — the caller must say so out loud. */
  truncated: boolean;
}

function isHeaderRow(row: readonly string[]): boolean {
  return row.length > 0 && row[0]?.trim().toLowerCase() === "subscriber_email";
}

/**
 * Turn the server's streamed CSV into a bounded, injection-safe share payload.
 *
 * `total` is the code's lifetime `times_redeemed`, used only to say how much
 * of it this export is. Pass 0 when it is unknown — the copy then refuses to
 * invent a denominator rather than implying the export is complete.
 */
export function discountRedemptionsCsv(
  raw: string,
  {
    code,
    total = 0,
    cap = DISCOUNT_EXPORT_MAX_ROWS,
  }: { code: string; total?: number; cap?: number },
): DiscountExport {
  const parsed = parseCsvRows(raw ?? "").filter(
    (row) => row.length > 1 || (row[0] ?? "").trim() !== "",
  );
  const data =
    parsed.length > 0 && isHeaderRow(parsed[0] ?? []) ? parsed.slice(1) : parsed;
  const limit = Math.max(0, Math.trunc(cap));
  const kept = data.slice(0, limit);
  const knownTotal = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  // A response that fills the cap EXACTLY is the dangerous case: it may be a
  // slice with no way to tell from here, so at-the-cap counts as truncated.
  const truncated =
    data.length > kept.length ||
    knownTotal > kept.length ||
    (limit > 0 && data.length >= limit);

  const lines: string[] = [COLUMNS.join(",")];
  for (const row of kept) {
    lines.push(
      [
        csvField(row[0] ?? ""),
        csvField(row[1] ?? ""),
        csvField(row[2] ?? ""),
      ].join(","),
    );
  }

  const label = code.trim() || "discount";
  return {
    body: lines.join("\n"),
    title: truncated
      ? `${label} redemptions — newest ${kept.length}${
          knownTotal > 0 ? ` of ${knownTotal}` : ""
        }`
      : `${label} redemptions (${kept.length})`,
    included: kept.length,
    truncated,
  };
}

/** The sentence shown after a share. */
export function discountExportNotice(result: DiscountExport): string {
  if (result.included === 0) {
    return "This code has no redemptions to export.";
  }
  return result.truncated
    ? `Shared the newest ${result.included} redemptions — the rest need the web export.`
    : `Shared ${result.included} ${result.included === 1 ? "redemption" : "redemptions"}.`;
}
