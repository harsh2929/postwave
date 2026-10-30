/**
 * csvShare — the CSV rules every "send me the list" action on this phone
 * shares, in one import-free module.
 *
 * Extracted from `dmarcExport` when a second export (suppressions) needed the
 * same three rules. Duplicating them would be the worst outcome: the one that
 * matters most is the one a second copy would quietly omit.
 *
 *  1. RFC4180 QUOTING. A reporter org name is attacker-adjacent free text
 *     ("Yahoo!, Inc."), and one unescaped comma silently shifts every later
 *     column.
 *  2. FORMULA INJECTION. A field beginning `=`, `+`, `-`, `@`, TAB or CR is
 *     EXECUTED by Excel and Sheets when the text is pasted. Every such field is
 *     prefixed with an apostrophe. This is the rule whose absence turns a
 *     support export into an attack on the support agent — and an email local
 *     part legitimately starts with `+`, so this is not theoretical.
 *  3. AN HONEST TRUNCATION. A share sheet is not a file: a 4,000-row payload
 *     is silently dropped or mangled by the receiving app. Exports are capped
 *     and the caller SAYS the set was capped, so nobody treats a partial
 *     export as the whole thing.
 */

/** Excel/Sheets treat these leading characters as the start of a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvField(value: unknown): string {
  const raw =
    value === null || value === undefined
      ? ""
      : typeof value === "number"
        ? Number.isFinite(value)
          ? String(value)
          : ""
        : String(value);
  // Neutralise before quoting: prefixing after the quote would put the
  // apostrophe outside the field and do nothing.
  const safe = FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
  if (safe === "") return "";
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

/** Join already-escaped fields into one line. */
export function csvLine(fields: readonly unknown[]): string {
  return fields.map(csvField).join(",");
}

/**
 * Parse RFC4180 text into rows of raw (unescaped) fields.
 *
 * Needed because some exports arrive as CSV the SERVER built — the API's
 * suppression export quotes correctly but does NOT formula-guard, so the text
 * has to be taken apart and re-emitted rather than forwarded. A naive
 * `split(",")` would corrupt any quoted field containing a comma or newline,
 * which is exactly the field an attacker controls.
 *
 * Trailing empty lines are dropped; a lone `\r\n` inside quotes is preserved.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === ",") {
      started = true;
      endField();
      continue;
    }
    if (ch === "\n") {
      endRow();
      continue;
    }
    if (ch === "\r") {
      // Bare CR and CRLF both terminate a row; the LF is consumed next pass.
      if (text[i + 1] === "\n") i += 1;
      endRow();
      continue;
    }
    started = true;
    field += ch;
  }
  if (started || field !== "" || row.length > 0) endRow();
  return rows;
}
