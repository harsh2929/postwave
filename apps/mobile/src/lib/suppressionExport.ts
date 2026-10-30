/**
 * suppressionExport — "send me the suppression list", from a phone.
 *
 * Compliance and support ask for the whole set, not a screenshot of page one.
 * The API already streams it: `GET /api/v1/suppressions/export` (mounted at
 * apps/api/main.go:2748, handler apps/api/internal/suppressions/import_export.go:360)
 * returns `text/csv` under `RequireScope(ScopeReadSubscribers)` — a read-only
 * scope, so on the session path any authenticated dashboard user may fetch it.
 * Rows come back newest-first (Repo.List `ORDER BY created_at DESC`), so a
 * capped export is the RECENT suppressions, which is the useful half.
 *
 * WHY THE SERVER'S CSV IS RE-EMITTED RATHER THAN FORWARDED. The server's
 * `csvJoinSuppressions` quotes per RFC4180 but does NOT neutralise leading
 * `=`, `+`, `-` or `@`. An email local part legitimately begins with `+`, and
 * anyone can self-serve a suppression by bouncing — so a forwarded export
 * pastes attacker-chosen formulas into a support agent's spreadsheet. The text
 * is parsed with `parseCsvRows` and re-emitted through `csvField`, which
 * neutralises them.
 *
 * WHY IT IS CAPPED. A share sheet is not a file: iOS silently mangles very
 * large text payloads, and `expo-file-system` is not a dependency of this app,
 * so a file URL is unavailable. The cap is stated in the title and reported in
 * a toast, so a partial export is never mistaken for the whole list.
 *
 * Import-free, so every rule here is testable in the node vitest run.
 */
import { csvField, parseCsvRows } from "@/lib/csvShare";

/**
 * Rows requested from the endpoint and rows kept for the share sheet. The
 * request cap keeps the transfer bounded (the endpoint's own ceiling is
 * 500,000); the share cap keeps the pasteboard payload usable.
 */
export const SUPPRESSION_EXPORT_MAX_ROWS = 500;

/** The query string for a bounded export request. */
export function suppressionExportPath(
  limit = SUPPRESSION_EXPORT_MAX_ROWS,
): string {
  const bounded = Math.max(
    1,
    Math.min(SUPPRESSION_EXPORT_MAX_ROWS, Math.trunc(limit) || 0),
  );
  return `/api/v1/suppressions/export?limit=${bounded}`;
}

export interface SuppressionExport {
  /** The text to hand to the share sheet. */
  body: string;
  /** Share-sheet subject line. */
  title: string;
  /** Data rows (header excluded) that made it in. */
  included: number;
  /** True when rows were dropped — the caller must say so out loud. */
  truncated: boolean;
}

const COLUMNS = ["email", "reason", "created_at"] as const;

function isHeaderRow(row: readonly string[]): boolean {
  return (
    row.length > 0 && row[0]?.trim().toLowerCase() === "email"
  );
}

/**
 * Turn the server's streamed CSV into a bounded, injection-safe share payload.
 *
 * `total` is what the list screen believes the tenant has, used only to say
 * how much of it this export is. Pass 0 when it is unknown — the copy then
 * refuses to invent a denominator rather than implying the export is complete.
 * It must be the UNFILTERED total: the list endpoint's `total` reflects the
 * SEARCH filter, and the export endpoint does not take that filter, so a
 * filtered denominator beside an unfiltered export is a lie in both directions.
 */
export function suppressionCsv(
  raw: string,
  { total = 0, cap = SUPPRESSION_EXPORT_MAX_ROWS }: {
    total?: number;
    cap?: number;
  } = {},
): SuppressionExport {
  const parsed = parseCsvRows(raw ?? "").filter(
    (row) => row.length > 1 || (row[0] ?? "").trim() !== "",
  );
  const data = parsed.length > 0 && isHeaderRow(parsed[0] ?? []) ? parsed.slice(1) : parsed;
  const limit = Math.max(0, Math.trunc(cap));
  const kept = data.slice(0, limit);
  const knownTotal = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  // A response that fills the cap EXACTLY is the dangerous case: the request
  // asked for `limit` rows and got `limit` rows, so the server may hold more
  // and this export cannot know. Claiming "Suppressed addresses (500)" there
  // would present a slice of a 400k-row table as the whole list. Treat
  // at-the-cap as truncated — the only honest reading — alongside the two
  // obvious sources (rows dropped here, and a known total that exceeds them).
  const truncated =
    data.length > kept.length ||
    knownTotal > kept.length ||
    (limit > 0 && data.length >= limit);

  const lines: string[] = [COLUMNS.join(",")];
  for (const row of kept) {
    lines.push(
      [csvField(row[0] ?? ""), csvField(row[1] ?? ""), csvField(row[2] ?? "")].join(
        ",",
      ),
    );
  }

  return {
    body: lines.join("\n"),
    title: truncated
      ? `Suppressed addresses — newest ${kept.length}${knownTotal > 0 ? ` of ${knownTotal}` : ""}`
      : `Suppressed addresses (${kept.length})`,
    included: kept.length,
    truncated,
  };
}

/**
 * The sentence shown after a share. Says out loud that the export is the whole
 * list rather than the search or reason filter currently on screen — exporting
 * something other than what the operator is looking at is the classic export
 * bug, and the honest fix when the endpoint cannot express the filter is to
 * NAME the difference, not to hide it.
 */
export function suppressionExportNotice(
  result: SuppressionExport,
  { filtered }: { filtered: boolean },
): string {
  const scope = filtered
    ? " It covers every suppressed address, not the filter on screen."
    : "";
  if (result.included === 0) {
    return "There was nothing to export.";
  }
  return result.truncated
    ? `Shared the newest ${result.included} suppressed addresses — the rest need the web export.${scope}`
    : `Shared ${result.included} suppressed ${result.included === 1 ? "address" : "addresses"}.${scope}`;
}
