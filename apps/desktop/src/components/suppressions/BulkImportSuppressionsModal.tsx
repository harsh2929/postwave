/**
 * BulkImportSuppressionsModal — SUB-050.
 *
 * Bulk-imports addresses onto the canonical subscriber_suppressions table
 * via POST /api/v1/suppressions/bulk-import. The send-time converger also
 * reads compatibility stores, so this surface never claims it is the only
 * source of effective suppression truth.
 *
 * Three input modes, all parsed client-side into the `{emails, reason}`
 * body the endpoint accepts:
 *
 *   1. JSON   — paste a JSON array: [{"email": "...", "reason": "..."}, ...]
 *               (or a bare ["a@x.com", ...] array of strings).
 *   2. CSV    — CSV-style multiline; auto-detects `email,reason` columns
 *               (an optional header row is detected + skipped).
 *   3. Emails — simple newline / comma / whitespace-separated addresses
 *               with a single default-reason dropdown for the whole batch.
 *
 * The backend takes ONE batch-wide reason (it has no per-row reason
 * field), so when the parsed rows carry per-row reasons we group by
 * reason and POST one bulk-import request per reason group, then merge
 * the counts. This keeps a compliance-relevant field (reason) accurate
 * instead of collapsing every row onto a single dominant reason.
 *
 * Interactive paste is intentionally capped at 30,000 chars; larger jobs use
 * the file importer. Every validation/reason conflict must be resolved before
 * submit, and failures in one reason group remain visible as a partial result.
 */

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";

import { ChoiceGroup, type ChoiceGroupOption } from "../ChoiceGroup";
import { Modal, ModalFooter } from "../Modal";
import {
  SUPPRESSION_REASONS_X1,
  type SuppressionBulkImportResult,
  suppressionsApi,
} from "../../lib/api-client";
import { redact } from "../../lib/auth";

/** Interactive-editor cap. Larger lists belong in the staged file flow. */
const MAX_PASTE_CHARS = 30_000;

/** Hard ceiling the server enforces; we surface it before submit. */
const MAX_ROWS = 50_000;

type Mode = "emails" | "csv" | "json";

const INPUT_MODE_OPTIONS: readonly ChoiceGroupOption<Mode>[] = [
  { value: "emails", label: "Emails", description: "One per line" },
  { value: "csv", label: "CSV", description: "email, reason" },
  { value: "json", label: "JSON", description: "Array of objects" },
];

/** A parsed candidate row plus any per-row reason override. */
interface ParsedRow {
  email: string;
  reason?: string;
}

/** Outcome of parsing the textarea for the active mode. */
interface ParseResult {
  rows: ParsedRow[];
  /** De-duplicated valid addresses (lowercased), for the live count. */
  validCount: number;
  /** First 10 human-readable problems found while parsing. */
  errors: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the merged counts once the import completes. */
  onImported: (result: SuppressionBulkImportResult) => void;
}

interface ImportGroupFailure {
  reason: string;
  count: number;
  message: string;
}

interface ImportResult extends SuppressionBulkImportResult {
  failedGroups: ImportGroupFailure[];
  requested: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function BulkImportSuppressionsModal({
  open,
  onClose,
  onImported,
}: Props): ReactElement {
  const [mode, setMode] = useState<Mode>("emails");
  const [text, setText] = useState<string>("");
  const [defaultReason, setDefaultReason] =
    useState<string>("manual_unsubscribe");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    if (!open && !busyRef.current) {
      setMode("emails");
      setText("");
      setDefaultReason("manual_unsubscribe");
      setBusy(false);
      setSubmitErr(null);
      setResult(null);
    }
  }, [open]);

  const parsed = useMemo<ParseResult>(
    () => parseInput(mode, text, defaultReason),
    [mode, text, defaultReason],
  );
  const conflictingEmails = useMemo(
    () => findReasonConflicts(parsed.rows, defaultReason),
    [defaultReason, parsed.rows],
  );

  const overCap = text.length > MAX_PASTE_CHARS;
  const overRows = parsed.validCount > MAX_ROWS;
  const canSubmit =
    !busy &&
    parsed.validCount > 0 &&
    !overCap &&
    !overRows &&
    parsed.errors.length === 0 &&
    conflictingEmails.length === 0;

  async function submit(): Promise<void> {
    if (!canSubmit || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setSubmitErr(null);

    // Group valid rows by their effective reason (per-row override, else
    // the batch default), de-duping addresses within each group. One
    // bulk-import request per reason group so the reason stays accurate.
    const groups = new Map<string, Set<string>>();
    for (const row of parsed.rows) {
      const email = row.email.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) continue;
      const reason =
        (row.reason || defaultReason).trim() || "manual_unsubscribe";
      let set = groups.get(reason);
      if (!set) {
        set = new Set<string>();
        groups.set(reason, set);
      }
      set.add(email);
    }

    const merged: SuppressionBulkImportResult = {
      imported: 0,
      skipped: 0,
      errors: [],
    };
    const failedGroups: ImportGroupFailure[] = [];

    try {
      for (const [reason, emails] of groups) {
        try {
          const res = await suppressionsApi.importBulk({
            emails: Array.from(emails),
            reason,
          });
          if (res.error) {
            failedGroups.push({
              reason,
              count: emails.size,
              message: redact(res.error.message),
            });
            continue;
          }
          merged.imported += res.data.imported;
          merged.skipped += res.data.skipped;
          if (res.data.errors?.length) {
            merged.errors.push(
              ...res.data.errors.map((error) => redact(error)),
            );
          }
        } catch {
          failedGroups.push({
            reason,
            count: emails.size,
            message: "The request did not complete.",
          });
        }
      }
      if (
        failedGroups.length > 0 &&
        merged.imported === 0 &&
        merged.skipped === 0
      ) {
        setSubmitErr(
          `No reason group completed. ${failedGroups[0]?.message ?? "Try again."}`,
        );
        return;
      }
      setResult({
        ...merged,
        failedGroups,
        requested: parsed.validCount,
      });
      if (merged.imported > 0 || merged.skipped > 0) onImported(merged);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const close = (): void => {
    if (!busyRef.current) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Bulk import suppressions"
      description="Add addresses to the suppression list the send loop enforces. Paste emails, CSV rows, or a JSON array — duplicates and already-suppressed addresses are skipped."
      size="lg"
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
    >
      {result ? (
        <ResultBlock result={result} />
      ) : (
        <InputBlock
          mode={mode}
          onChangeMode={setMode}
          text={text}
          onChangeText={setText}
          defaultReason={defaultReason}
          onChangeDefaultReason={setDefaultReason}
          parsed={parsed}
          overCap={overCap}
          overRows={overRows}
          conflictingEmails={conflictingEmails}
          submitErr={submitErr}
        />
      )}

      <ModalFooter>
        <button type="button" className="btn" onClick={close} disabled={busy}>
          {result ? "Done" : "Cancel"}
        </button>
        {!result ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {busy
              ? "Importing…"
              : parsed.validCount > 0
                ? `Import ${parsed.validCount.toLocaleString()} address${
                    parsed.validCount === 1 ? "" : "es"
                  }`
                : "Import"}
          </button>
        ) : null}
      </ModalFooter>
    </Modal>
  );
}

interface InputBlockProps {
  mode: Mode;
  onChangeMode: (m: Mode) => void;
  text: string;
  onChangeText: (s: string) => void;
  defaultReason: string;
  onChangeDefaultReason: (s: string) => void;
  parsed: ParseResult;
  overCap: boolean;
  overRows: boolean;
  conflictingEmails: string[];
  submitErr: string | null;
}

function InputBlock({
  mode,
  onChangeMode,
  text,
  onChangeText,
  defaultReason,
  onChangeDefaultReason,
  parsed,
  overCap,
  overRows,
  conflictingEmails,
  submitErr,
}: InputBlockProps): ReactElement {
  const placeholder =
    mode === "json"
      ? '[{"email": "a@example.com", "reason": "hard_bounce"}, {"email": "b@example.com"}]'
      : mode === "csv"
        ? "email,reason\nbounced@example.com,hard_bounce\nleft@example.com,manual_unsubscribe"
        : "one@example.com\ntwo@example.com\nthree@example.com";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <ChoiceGroup
        legend="Input mode"
        value={mode}
        options={INPUT_MODE_OPTIONS}
        onChange={onChangeMode}
        style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)" }}
      />

      <label className="field-label" htmlFor="bulk-import-suppression-data">
        Suppression data
      </label>
      <textarea
        id="bulk-import-suppression-data"
        className="input"
        value={text}
        onChange={(e) => onChangeText(e.target.value)}
        placeholder={placeholder}
        aria-invalid={
          parsed.errors.length > 0 ||
          conflictingEmails.length > 0 ||
          overCap ||
          overRows
        }
        rows={10}
        spellCheck={false}
        style={{
          fontFamily:
            "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 12,
          resize: "vertical",
        }}
      />

      {mode === "emails" || mode === "csv" ? (
        <div className="field">
          <label className="field-label" htmlFor="bulk-import-default-reason">
            {mode === "csv" ? "Default reason" : "Reason"}
          </label>
          <select
            id="bulk-import-default-reason"
            className="input"
            value={defaultReason}
            onChange={(e) => onChangeDefaultReason(e.target.value)}
          >
            {SUPPRESSION_REASONS_X1.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            {mode === "csv"
              ? "Used for rows whose second (reason) column is empty."
              : "Applied to every address in this batch."}
          </div>
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 11 }}>
          Each object may set its own <code>reason</code>; objects without one
          default to <code>manual_unsubscribe</code>.
        </div>
      )}

      <CountRow
        validCount={parsed.validCount}
        charCount={text.length}
        overCap={overCap}
        overRows={overRows}
      />

      {parsed.errors.length > 0 ? (
        <ErrorList
          title={`Validation (${parsed.errors.length} issue${
            parsed.errors.length === 1 ? "" : "s"
          })`}
          items={parsed.errors}
        />
      ) : null}

      {conflictingEmails.length > 0 ? (
        <ErrorList
          title={`Conflicting reasons (${conflictingEmails.length})`}
          items={conflictingEmails
            .slice(0, 10)
            .map(
              (email) =>
                `${email}: choose one reason for this address before importing`,
            )}
        />
      ) : null}

      {parsed.errors.length > 0 || conflictingEmails.length > 0 ? (
        <div className="field-error" role="alert">
          Resolve every validation and reason conflict before importing. No rows
          have been submitted.
        </div>
      ) : null}

      {submitErr ? (
        <div className="field-error" role="alert">
          {submitErr}
        </div>
      ) : null}
    </div>
  );
}

function CountRow({
  validCount,
  charCount,
  overCap,
  overRows,
}: {
  validCount: number;
  charCount: number;
  overCap: boolean;
  overRows: boolean;
}): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 11,
        }}
      >
        <span className="muted">
          <strong style={{ color: "var(--pw-fg)" }}>
            {validCount.toLocaleString()}
          </strong>{" "}
          valid address{validCount === 1 ? "" : "es"} detected
        </span>
        <span
          style={{
            color: overCap ? "var(--pw-danger)" : "var(--pw-fg-muted)",
          }}
        >
          {charCount.toLocaleString()} / {MAX_PASTE_CHARS.toLocaleString()}{" "}
          chars
        </span>
      </div>
      {overCap ? (
        <div className="field-error">
          Paste exceeds the {MAX_PASTE_CHARS.toLocaleString()}-character
          interactive limit. Use Import CSV for a larger file so it can be
          validated before processing.
        </div>
      ) : null}
      {overRows ? (
        <div className="field-error">
          {validCount.toLocaleString()} addresses exceeds the{" "}
          {MAX_ROWS.toLocaleString()}-per-import limit. Split into smaller
          batches.
        </div>
      ) : null}
    </div>
  );
}

function ResultBlock({ result }: { result: ImportResult }): ReactElement {
  const first10 = result.errors.slice(0, 10);
  const partial = result.failedGroups.length > 0 || result.errors.length > 0;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <div
        style={{
          padding: 12,
          borderRadius: 6,
          background: "color-mix(in srgb, var(--pw-accent) 8%, transparent)",
          border:
            "1px solid color-mix(in srgb, var(--pw-accent) 28%, transparent)",
        }}
      >
        <div style={{ fontSize: 13, color: "var(--pw-fg)", fontWeight: 500 }}>
          {partial ? "Import partially complete" : "Import complete"}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          {partial
            ? `${result.imported.toLocaleString()} of ${result.requested.toLocaleString()} requested addresses were newly added. Review every failed group before retrying.`
            : "Every reason group completed. Existing addresses were skipped without changing their recorded reason."}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 8,
        }}
      >
        <Stat label="Imported" value={result.imported} positive />
        <Stat label="Skipped" value={result.skipped} />
        <Stat
          label="Errors"
          value={result.errors.length}
          negative={result.errors.length > 0}
        />
      </div>

      {first10.length > 0 ? (
        <ErrorList title={`Errors (first ${first10.length})`} items={first10} />
      ) : null}

      {result.failedGroups.length > 0 ? (
        <ErrorList
          title={`Failed reason groups (${result.failedGroups.length})`}
          items={result.failedGroups.map(
            (failure) =>
              `${failure.reason} · ${failure.count.toLocaleString()} address${failure.count === 1 ? "" : "es"}: ${failure.message}`,
          )}
        />
      ) : null}
    </div>
  );
}

function ErrorList({
  title,
  items,
}: {
  title: string;
  items: string[];
}): ReactElement {
  return (
    <div>
      <div
        className="muted"
        style={{
          fontSize: 11,
          marginBottom: 4,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        {title}
      </div>
      <div
        style={{
          maxHeight: 140,
          overflowY: "auto",
          border: "1px solid var(--pw-border)",
          borderRadius: 4,
          fontSize: 11,
          fontFamily:
            "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          background: "var(--pw-bg-elev-2)",
          padding: 6,
        }}
      >
        {items.map((row, i) => (
          <div key={i} style={{ color: "var(--pw-fg-muted)" }}>
            {row}
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  positive,
  negative,
}: {
  label: string;
  value: number;
  positive?: boolean;
  negative?: boolean;
}): ReactElement {
  return (
    <div
      style={{
        background: "var(--pw-bg-elev-2)",
        borderRadius: 4,
        padding: "8px 10px",
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: "var(--pw-fg-muted)",
        }}
      >
        {label}
      </div>
      <div
        className="tabular"
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: positive
            ? "var(--pw-accent)"
            : negative
              ? "var(--pw-danger)"
              : "var(--pw-fg)",
        }}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

/* ---------- parsing ------------------------------------------------- */

/** Valid reason values, for CSV/JSON per-row reason validation. */
const VALID_REASONS = new Set<string>(
  SUPPRESSION_REASONS_X1.map((r) => r.value),
);

function pushErr(errors: string[], msg: string): void {
  if (errors.length < 10) errors.push(msg);
}

function parseInput(
  mode: Mode,
  text: string,
  defaultReason: string,
): ParseResult {
  if (mode === "json") return parseJson(text);
  if (mode === "csv") return parseCsv(text, defaultReason);
  return parseEmails(text);
}

function dedupeAndCount(rows: ParsedRow[]): number {
  const seen = new Set<string>();
  for (const r of rows) {
    const email = r.email.trim().toLowerCase();
    if (EMAIL_RE.test(email)) seen.add(email);
  }
  return seen.size;
}

function findReasonConflicts(
  rows: ParsedRow[],
  defaultReason: string,
): string[] {
  const byEmail = new Map<string, Set<string>>();
  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) continue;
    const reason = (row.reason || defaultReason).trim() || "manual_unsubscribe";
    const reasons = byEmail.get(email) ?? new Set<string>();
    reasons.add(reason);
    byEmail.set(email, reasons);
  }
  return Array.from(byEmail.entries())
    .filter(([, reasons]) => reasons.size > 1)
    .map(([email]) => email)
    .sort((a, b) => a.localeCompare(b));
}

function parseEmails(text: string): ParseResult {
  const errors: string[] = [];
  const rows: ParsedRow[] = [];
  const tokens = text
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  for (const tok of tokens) {
    if (EMAIL_RE.test(tok.toLowerCase())) {
      rows.push({ email: tok });
    } else {
      pushErr(errors, `Not an email: ${tok}`);
    }
  }
  return { rows, validCount: dedupeAndCount(rows), errors };
}

function parseCsv(text: string, defaultReason: string): ParseResult {
  const errors: string[] = [];
  const rows: ParsedRow[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const emailCol = cols[0]?.toLowerCase() ?? "";
    // Header row: first column literally "email" — skip it.
    if (i === 0 && (emailCol === "email" || emailCol === "e-mail")) {
      continue;
    }
    if (!EMAIL_RE.test(emailCol)) {
      pushErr(errors, `Line ${i + 1}: invalid email "${cols[0] ?? ""}"`);
      continue;
    }
    const rawReason = cols[1] ?? "";
    let reason = defaultReason;
    if (rawReason) {
      if (VALID_REASONS.has(rawReason)) {
        reason = rawReason;
      } else {
        pushErr(
          errors,
          `Line ${i + 1}: unknown reason "${rawReason}" — choose a supported reason`,
        );
      }
    }
    rows.push({ email: emailCol, reason });
  }
  return { rows, validCount: dedupeAndCount(rows), errors };
}

function parseJson(text: string): ParseResult {
  const errors: string[] = [];
  const rows: ParsedRow[] = [];
  const trimmed = text.trim();
  if (!trimmed) return { rows, validCount: 0, errors };

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return {
      rows,
      validCount: 0,
      errors: ['Not valid JSON. Paste an array like [{"email": "…"}].'],
    };
  }
  if (!Array.isArray(data)) {
    return { rows, validCount: 0, errors: ["JSON must be an array."] };
  }
  data.forEach((entry, idx) => {
    // Allow a bare string array (["a@x.com", ...]) or {email, reason}.
    if (typeof entry === "string") {
      if (EMAIL_RE.test(entry.toLowerCase())) {
        rows.push({ email: entry });
      } else {
        pushErr(errors, `[${idx}]: invalid email "${entry}"`);
      }
      return;
    }
    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const email = typeof obj.email === "string" ? obj.email : "";
      if (!EMAIL_RE.test(email.toLowerCase())) {
        pushErr(errors, `[${idx}]: missing or invalid "email"`);
        return;
      }
      const reasonRaw = typeof obj.reason === "string" ? obj.reason : "";
      if (reasonRaw && !VALID_REASONS.has(reasonRaw)) {
        pushErr(
          errors,
          `[${idx}]: unknown reason "${reasonRaw}" — choose a supported reason`,
        );
        rows.push({ email });
        return;
      }
      rows.push({ email, reason: reasonRaw || undefined });
      return;
    }
    pushErr(errors, `[${idx}]: not a string or {email, reason} object`);
  });
  return { rows, validCount: dedupeAndCount(rows), errors };
}
