// SPDX-License-Identifier: AGPL-3.0-only
//
// Why a pasted or imported row wasn't added, in words the operator can act on.
//
// Paste emails (POST /subscribers/bulk-paste), the CSV import's preflight and
// its recorded row failures (GET /subscriber-imports/{id}/errors) all carry a
// stable `error_code` beside a server sentence. Codes with a known meaning get
// one reviewed wording everywhere they appear; anything else shows the
// server's own sentence, which names the field or rule involved and never the
// row's data.

export interface SubscriberRowFailure {
  error_code?: string;
  error?: string;
}

const REASONS: Record<string, string> = {
  erasure_blocked:
    "Permanently erased when the contact was deleted or by a privacy request, so it can't be added again.",
  invalid_email: "Not a valid email address.",
  duplicate_in_file: "Repeats an address from an earlier row in this file.",
  csv_parse_error: "This row couldn't be read as CSV.",
  engine_sync_failed: "Couldn't be synced with the sending service. Try again in a moment.",
  subscriber_conflict: "Clashes with an existing contact.",
  existing_subscriber_conflict: "Already a contact, and this import is set to fail on existing contacts.",
};

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capitalised = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** The reason for one failed row. */
export function describeSubscriberRowError(row: SubscriberRowFailure): string {
  const code = row.error_code?.trim() ?? "";
  const known = REASONS[code];
  if (known) return known;
  const server = row.error ? sentence(row.error) : "";
  return server || "Couldn't be added.";
}

/**
 * One line for a toast: how many rows failed and, where they share a cause,
 * what it was. "2 were permanently erased and can't be added again; 1
 * couldn't be added."
 */
export function summarizeSubscriberRowFailures(rows: readonly SubscriberRowFailure[]): string {
  if (rows.length === 0) return "";
  const erased = rows.filter((row) => row.error_code === "erasure_blocked").length;
  const other = rows.length - erased;
  const parts: string[] = [];
  if (erased > 0) {
    parts.push(
      `${erased.toLocaleString()} ${erased === 1 ? "was" : "were"} permanently erased and can't be added again`,
    );
  }
  if (other > 0) {
    parts.push(`${other.toLocaleString()} couldn't be added`);
  }
  return `${parts.join("; ")}.`;
}
