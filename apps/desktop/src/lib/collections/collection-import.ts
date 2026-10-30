import type { CollectionRow, CollectionSourceType } from "../api-client";
import { collectionPersistenceJsonBytes } from "./collection-json-size";

/**
 * Import limits deliberately sit below both the API's 4 MiB request limit and
 * the desktop transport's 2 MiB response limit. Create currently echoes the
 * stored rows, so accepting a larger payload would create an ambiguous
 * "committed on the server, unreadable by this client" outcome.
 */
export const COLLECTION_IMPORT_FILE_MAX_BYTES = 1024 * 1024;
export const COLLECTION_IMPORT_DATA_MAX_BYTES = 1024 * 1024;
export const COLLECTION_IMPORT_MAX_ROWS = 10_000;
export const COLLECTION_IMPORT_MAX_COLUMNS = 100;
export const COLLECTION_IMPORT_MAX_STRING_BYTES = 64 * 1024;
export const COLLECTION_IMPORT_MAX_COLUMN_CHARS = 128;
export const COLLECTION_IMPORT_MAX_ENCODED_ROW_BYTES = 256 * 1024;

const BLOCKED_COLUMN_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const UNSAFE_KEY_CHARACTERS =
  /[\p{Cc}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

function characterCount(value: string): number {
  return Array.from(value).length;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export interface ParsedCollectionUpload {
  rows: CollectionRow[];
  /** First-seen column order, used by the bounded preview table. */
  columns: string[];
  sourceType: CollectionSourceType;
  encodedBytes: number;
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateColumn(raw: string, position: number): string {
  const withoutBom = raw.replace(/^\uFEFF/u, "");
  const column = withoutBom.trim();
  if (withoutBom !== column) {
    throw new Error(
      `Column ${position} has leading or trailing whitespace. Remove it so the stored key is unambiguous.`,
    );
  }
  if (!isWellFormedUnicode(column)) {
    throw new Error(`Column ${position} contains invalid Unicode.`);
  }
  if (column.length === 0) {
    throw new Error(`Column ${position} needs a name.`);
  }
  if (characterCount(column) > COLLECTION_IMPORT_MAX_COLUMN_CHARS) {
    throw new Error(
      `Column ${position} is longer than ${COLLECTION_IMPORT_MAX_COLUMN_CHARS.toLocaleString()} characters.`,
    );
  }
  if (UNSAFE_KEY_CHARACTERS.test(column)) {
    throw new Error(
      `Column ${position} contains unsupported control or text-direction characters.`,
    );
  }
  if (BLOCKED_COLUMN_NAMES.has(column.toLowerCase())) {
    throw new Error(`“${column}” is not a supported column name.`);
  }
  return column;
}

function validateColumns(rawColumns: string[]): string[] {
  if (rawColumns.length === 0) throw new Error("The file has no columns.");
  if (rawColumns.length > COLLECTION_IMPORT_MAX_COLUMNS) {
    throw new Error(
      `Use ${COLLECTION_IMPORT_MAX_COLUMNS.toLocaleString()} columns or fewer.`,
    );
  }
  const columns = rawColumns.map((column, index) =>
    validateColumn(column, index + 1),
  );
  const seen = new Set<string>();
  for (const column of columns) {
    const normalized = column.toLowerCase();
    if (seen.has(normalized)) {
      throw new Error(`Column names must be unique; “${column}” appears twice.`);
    }
    seen.add(normalized);
  }
  return columns;
}

function validateCell(value: string, row: number, column: number): string {
  if (!isWellFormedUnicode(value)) {
    throw new Error(`Row ${row}, column ${column} contains invalid Unicode.`);
  }
  if (value.includes("\u0000")) {
    throw new Error(
      `Row ${row}, column ${column} contains a NUL character, which cannot be stored in reference data.`,
    );
  }
  if (bytes(value) > COLLECTION_IMPORT_MAX_STRING_BYTES) {
    throw new Error(
      `Row ${row}, column ${column} exceeds the 64 KiB UTF-8 string limit.`,
    );
  }
  return value;
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let quoteClosed = false;

  const pushField = (): void => {
    record.push(field);
    field = "";
    quoteClosed = false;
    if (record.length > COLLECTION_IMPORT_MAX_COLUMNS) {
      throw new Error(
        `Use ${COLLECTION_IMPORT_MAX_COLUMNS.toLocaleString()} columns or fewer.`,
      );
    }
  };
  const pushRecord = (): void => {
    pushField();
    // A physical line after the header is data, even when its only value is
    // an empty string. Silently skipping it would change one-column tables;
    // for wider tables the normal row-width diagnostic rejects the ambiguity.
    records.push(record);
    if (records.length > COLLECTION_IMPORT_MAX_ROWS + 1) {
      throw new Error(
        `Use ${COLLECTION_IMPORT_MAX_ROWS.toLocaleString()} rows or fewer.`,
      );
    }
    record = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else {
        field += character;
      }
    } else if (quoteClosed) {
      if (character === ",") {
        pushField();
      } else if (character === "\n" || character === "\r") {
        if (character === "\r" && text[index + 1] === "\n") index += 1;
        pushRecord();
      } else {
        throw new Error("A quoted CSV field must end before a comma or new line.");
      }
    } else if (character === '"') {
      if (field.length > 0) {
        throw new Error("A quoted CSV field must start with a quote.");
      }
      inQuotes = true;
    } else if (character === ",") {
      pushField();
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      pushRecord();
    } else {
      field += character;
    }
  }
  if (inQuotes) throw new Error("The CSV contains an unterminated quoted field.");
  if (field !== "" || record.length > 0 || quoteClosed) pushRecord();
  return records;
}

function parseCsv(text: string): Omit<ParsedCollectionUpload, "sourceType" | "encodedBytes"> {
  const records = parseCsvRecords(text);
  if (records.length < 2) {
    throw new Error("The CSV needs a header and at least one data row.");
  }
  const columns = validateColumns(records[0] ?? []);
  const rows = records.slice(1).map((record, rowIndex) => {
    if (record.length !== columns.length) {
      throw new Error(
        `Row ${rowIndex + 2} has ${record.length.toLocaleString()} cells; every row must match the ${columns.length.toLocaleString()}-column header.`,
      );
    }
    const row: CollectionRow = Object.create(null) as CollectionRow;
    columns.forEach((column, columnIndex) => {
      row[column] = validateCell(
        record[columnIndex] ?? "",
        rowIndex + 2,
        columnIndex + 1,
      );
    });
    return row;
  });
  return { columns, rows };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))) ||
    typeof value === "boolean"
  );
}

/**
 * JSON.parse intentionally keeps the last duplicate object key. Detect those
 * keys first so an import can never silently change customer data. Syntax is
 * still authoritatively validated by JSON.parse immediately afterwards.
 */
function assertNoDuplicateJsonKeys(text: string): void {
  type Context =
    | { kind: "array" }
    | { kind: "object"; expectingKey: boolean; keys: Set<string> };
  const stack: Context[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      for (; index < text.length; index += 1) {
        const next = text[index];
        if (escaped) {
          escaped = false;
        } else if (next === "\\") {
          escaped = true;
        } else if (next === '"') {
          break;
        }
      }
      const context = stack.at(-1);
      if (context?.kind === "object" && context.expectingKey) {
        const token = text.slice(start, index + 1);
        const key = JSON.parse(token) as unknown;
        if (typeof key !== "string") continue;
        if (context.keys.has(key)) {
          throw new Error(`JSON contains the duplicate object key “${key}”.`);
        }
        context.keys.add(key);
        context.expectingKey = false;
      }
      continue;
    }
    if (character === "{") {
      stack.push({ kind: "object", expectingKey: true, keys: new Set() });
    } else if (character === "[") {
      stack.push({ kind: "array" });
    } else if (character === "}" || character === "]") {
      stack.pop();
    } else if (character === ",") {
      const context = stack.at(-1);
      if (context?.kind === "object") context.expectingKey = true;
    }
    if (stack.length > 16) {
      throw new Error("JSON nesting is too deep for a flat reference table.");
    }
  }
}

/**
 * JSON.parse exposes only binary numbers, so precision already lost there is
 * impossible to recover during row validation. Require every source token to
 * survive the parse/stringify boundary byte-for-byte; operators can quote
 * decimals, exponent forms, negative zero, or identifiers when spelling is
 * significant.
 */
function assertCanonicalJsonNumbers(text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      index += 1;
      let escaped = false;
      for (; index < text.length; index += 1) {
        const next = text[index];
        if (escaped) escaped = false;
        else if (next === "\\") escaped = true;
        else if (next === '"') break;
      }
      continue;
    }
    if (character !== "-" && !(character && /[0-9]/u.test(character))) {
      continue;
    }
    const token = text
      .slice(index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (!token) continue;
    const canonical = JSON.stringify(Number(token));
    if (canonical !== token) {
      throw new Error(
        `JSON number “${token}” cannot round-trip exactly. Use its canonical form${canonical && canonical !== "null" ? ` “${canonical}”` : ""}. Quote long numeric identifiers and precision-critical decimals.`,
      );
    }
    index += token.length - 1;
  }
}

function parseJson(text: string): Omit<ParsedCollectionUpload, "sourceType" | "encodedBytes"> {
  assertNoDuplicateJsonKeys(text);
  assertCanonicalJsonNumbers(text);
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("JSON must be an array of flat row objects.");
  }
  if (parsed.length === 0) throw new Error("The JSON array has no rows.");
  if (parsed.length > COLLECTION_IMPORT_MAX_ROWS) {
    throw new Error(
      `Use ${COLLECTION_IMPORT_MAX_ROWS.toLocaleString()} rows or fewer.`,
    );
  }

  const firstSeenColumns: string[] = [];
  const normalizedColumns = new Map<string, string>();
  const rows = parsed.map((value, rowIndex) => {
    if (!isPlainObject(value)) {
      throw new Error(`JSON row ${rowIndex + 1} must be an object.`);
    }
    const row: CollectionRow = Object.create(null) as CollectionRow;
    const entries = Object.entries(value);
    for (const [columnIndex, [rawColumn, cell]] of entries.entries()) {
      const column = validateColumn(rawColumn, columnIndex + 1);
      const normalized = column.toLowerCase();
      const prior = normalizedColumns.get(normalized);
      if (prior && prior !== column) {
        throw new Error(
          `Column names are case-insensitive; “${prior}” and “${column}” conflict.`,
        );
      }
      if (!prior) {
        normalizedColumns.set(normalized, column);
        firstSeenColumns.push(column);
        if (firstSeenColumns.length > COLLECTION_IMPORT_MAX_COLUMNS) {
          throw new Error(
            `Use ${COLLECTION_IMPORT_MAX_COLUMNS.toLocaleString()} columns or fewer.`,
          );
        }
      }
      if (!isScalar(cell)) {
        throw new Error(
          `JSON row ${rowIndex + 1}, column “${column}” must be a string, safe number, boolean, or null. Quote long numeric identifiers so they remain exact.`,
        );
      }
      if (typeof cell === "string") {
        validateCell(cell, rowIndex + 1, columnIndex + 1);
      }
      row[column] = cell;
    }
    return row;
  });
  const columns = validateColumns(firstSeenColumns);
  return { columns, rows };
}

/** Parse a bounded, flat lookup-table file without changing user values. */
export function parseCollectionUpload(
  name: string,
  text: string,
): ParsedCollectionUpload {
  const normalizedName = name.toLowerCase();
  const result = normalizedName.endsWith(".json")
    ? parseJson(text)
    : normalizedName.endsWith(".csv")
      ? parseCsv(text)
      : (() => {
          throw new Error("Choose a .csv or .json file.");
        })();
  if (
    result.rows.some(
      (row) =>
        collectionPersistenceJsonBytes(row) >
        COLLECTION_IMPORT_MAX_ENCODED_ROW_BYTES,
    )
  ) {
    throw new Error(
      "A parsed row exceeds the safe 256 KiB encoded-row limit. Split large values across smaller rows.",
    );
  }
  const encodedBytes = collectionPersistenceJsonBytes(result.rows);
  if (encodedBytes > COLLECTION_IMPORT_DATA_MAX_BYTES) {
    throw new Error(
      "The parsed rows exceed the safe 1 MiB save limit. Split the file into smaller reference tables.",
    );
  }
  return {
    ...result,
    encodedBytes,
    sourceType: "uploaded",
  };
}
