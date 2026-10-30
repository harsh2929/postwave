/**
 * formSubmissionsExport — "send me this form's signups", from a phone.
 *
 * The forms detail screen shows the newest submissions and stops there; the
 * API already streams the whole set as CSV
 * (`GET /api/v1/forms/{id}/submissions.csv`, admin scope — the rows carry
 * PII). This module turns that stream into a bounded, injection-safe share
 * payload, exactly the treatment `discountExport` gives redemptions and for
 * the same reasons:
 *
 *  - RE-EMITTED, NOT FORWARDED. The server writes with `encoding/csv`, which
 *    does not neutralise a leading `=`, `+`, `-` or `@`; emails and
 *    free-typed custom fields are attacker-suppliable, and spreadsheets
 *    execute those. Every field goes back out through `csvField`.
 *  - CAPPED. A share sheet is not a file; iOS mangles very large text
 *    payloads. The cap is stated in the title and the after-toast so a
 *    partial export is never mistaken for the whole list.
 *  - COLUMNS ARE A DELIBERATE SUBSET. The server streams
 *    id,email,status,submitted_at,confirmed_at,ip,user_agent,custom_fields_json
 *    (handlers.go:372). The last three are dropped here: request metadata and
 *    arbitrary custom fields balloon a bounded payload and hand a colleague
 *    more PII than "who signed up and did they confirm" needs. The web export
 *    remains the complete artifact.
 *
 * Import-free apart from `csvShare` (itself import-free) — node-testable.
 */
import { csvField, parseCsvRows } from "@/lib/csvShare";

/** Rows kept for the share sheet. The endpoint itself streams everything. */
export const FORM_EXPORT_MAX_ROWS = 500;

/** The server's first five columns, in the server's order. */
const COLUMNS = [
  "id",
  "email",
  "status",
  "submitted_at",
  "confirmed_at",
] as const;

export interface FormSubmissionsExport {
  /** The text to hand to the share sheet. */
  body: string;
  /** Share-sheet subject line. */
  title: string;
  /** Data rows (header excluded) that made it in. */
  included: number;
  /** True when rows were dropped — the caller must say so out loud. */
  truncated: boolean;
}

/**
 * A header row is one that NAMES the identity columns — wherever the server
 * put them. The earlier check looked for "email" in the SECOND cell, which
 * is itself a positional assumption: reorder the columns and the header row
 * was not recognised as a header, so it shipped as data and every row after
 * it was read positionally. Both halves of the same leak.
 */
function isHeaderRow(row: readonly string[]): boolean {
  const names = new Set(
    row.map((cell) => (typeof cell === "string" ? cell.trim().toLowerCase() : "")),
  );
  return names.has("email") && names.has("id");
}

/**
 * Where each kept column sits in THIS response, by header name. Null when
 * there is no header to read, so the caller falls back to the documented
 * order; -1 for a kept column the header does not carry, which then ships
 * empty rather than borrowing a neighbour's value.
 */
function columnPositions(
  header: readonly string[] | undefined,
): number[] | null {
  if (!Array.isArray(header)) return null;
  const byName = new Map<string, number>();
  header.forEach((cell, index) => {
    const name = typeof cell === "string" ? cell.trim().toLowerCase() : "";
    if (name && !byName.has(name)) byName.set(name, index);
  });
  return COLUMNS.map((column) => byName.get(column) ?? -1);
}

/** Bound and re-emit the server's stream. `formName` labels the artifact. */
export function formSubmissionsCsvShare(
  raw: string,
  {
    formName,
    cap = FORM_EXPORT_MAX_ROWS,
  }: { formName: string; cap?: number },
): FormSubmissionsExport {
  const parsed = parseCsvRows(raw ?? "").filter(
    (row) => row.length > 1 || (row[0] ?? "").trim() !== "",
  );
  const data =
    parsed.length > 0 && isHeaderRow(parsed[0] ?? []) ? parsed.slice(1) : parsed;
  const limit = Math.max(0, Math.trunc(cap));
  const kept = data.slice(0, limit);
  // A response that fills the cap EXACTLY may be a slice with no way to tell
  // from here, so at-the-cap counts as truncated.
  const truncated = data.length > kept.length || (limit > 0 && data.length >= limit);

  // Resolve each kept column by HEADER NAME, the way productEventsExport does.
  // The earlier positional read assumed the server's first five columns were
  // id/email/status/submitted_at/confirmed_at in that order; a reorder on
  // the server would have shipped ip, user_agent or a custom field under an
  // identity label — the exact leak this export exists to prevent. With no
  // header row the server's documented order is the only information there
  // is, so that case keeps positional reads.
  const header = parsed.length > 0 && isHeaderRow(parsed[0] ?? []) ? parsed[0] : undefined;
  const positions = columnPositions(header);
  const lines: string[] = [COLUMNS.join(",")];
  for (const row of kept) {
    lines.push(
      COLUMNS.map((_, index) => {
        const at = positions ? positions[index] : index;
        return csvField(at === undefined || at < 0 ? "" : (row[at] ?? ""));
      }).join(","),
    );
  }

  const label = formName.trim() || "form";
  return {
    body: lines.join("\n"),
    title: truncated
      ? `${label} submissions — newest ${kept.length}`
      : `${label} submissions (${kept.length})`,
    included: kept.length,
    truncated,
  };
}

/** The sentence shown after a share. */
export function formSubmissionsExportNotice(
  result: FormSubmissionsExport,
): string {
  if (result.included === 0) {
    return "This form has no submissions to export.";
  }
  return result.truncated
    ? `Shared the newest ${result.included} submissions — the full file needs the web export.`
    : `Shared ${result.included} ${result.included === 1 ? "submission" : "submissions"}.`;
}
