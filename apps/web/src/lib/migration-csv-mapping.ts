// SPDX-License-Identifier: AGPL-3.0-only
//
// Client-side CSV header parsing + email-column detection for the generic CSV
// import confirm step (MIGR-023). The backend auto-maps columns, but before
// this the user uploaded blind — with no way to see the detected headers, pick
// the email column, or catch a file with no email column before a failed
// import. We read only the first line in the browser to power a confirm step;
// per-column *renaming* is not transmitted (the backend has no mapping-ingest
// endpoint), so this is a validation/confirmation gate, not a remap.

/** Header names that indicate the email column, matched case-insensitively. */
const EMAIL_HEADER_HINTS = [
  "email",
  "email address",
  "email_address",
  "e-mail",
  "emailaddress",
  "primary email",
];

/**
 * Parse a single CSV header line into trimmed column names. Handles
 * double-quoted fields (with escaped `""`) and commas inside quotes. Returns []
 * for an empty line.
 */
export function parseCsvHeaderRow(line: string): string[] {
  // Excel and several ESP exports prefix UTF-8 CSVs with a BOM. Treat it as
  // transport metadata, not part of the first header name, so `email` still
  // auto-detects instead of forcing a misleading manual mapping step.
  const source = line.replace(/^\uFEFF/u, "").replace(/\r$/, "");
  if (source.trim() === "") return [];
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** Extract just the header row from raw CSV text (up to the first newline). */
export function extractHeaderLine(text: string): string {
  const newline = text.search(/\r?\n/);
  return newline === -1 ? text : text.slice(0, newline);
}

/**
 * Index of the most likely email column, or -1 if none is recognisable.
 * Exact hint match wins over a header that merely contains "email".
 */
export function detectEmailColumn(headers: string[]): number {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  for (let i = 0; i < normalized.length; i += 1) {
    if (EMAIL_HEADER_HINTS.includes(normalized[i]!)) return i;
  }
  for (let i = 0; i < normalized.length; i += 1) {
    if (normalized[i]!.includes("email")) return i;
  }
  return -1;
}

export interface CsvColumnValidation {
  ok: boolean;
  error?: string;
}

/**
 * A CSV import needs a chosen email column that is in range and non-empty.
 */
export function validateCsvColumns(
  headers: string[],
  emailColumnIndex: number,
): CsvColumnValidation {
  if (headers.length === 0) {
    return { ok: false, error: "No columns were detected in this file." };
  }
  if (emailColumnIndex < 0 || emailColumnIndex >= headers.length) {
    return {
      ok: false,
      error: "Choose which column holds the subscriber email address.",
    };
  }
  if ((headers[emailColumnIndex] ?? "").trim() === "") {
    return {
      ok: false,
      error: "The selected email column has no header name.",
    };
  }
  return { ok: true };
}
