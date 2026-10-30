/**
 * ImportSuppressionsModal — proper multipart CSV upload for the
 * suppression list.
 *
 * Replaces the text-paste flow in the legacy Suppressions page. The
 * backend's import endpoint (`POST /api/v1/suppressions/import`) accepts
 * a CSV file via multipart upload with an optional `default_reason`
 * field. CSV format:
 *
 *     email,reason
 *     bounced@example.com,hard_bounce
 *     complained@example.com,complaint
 *
 * Headers are auto-detected (case-insensitive `email` in the first
 * column). Up to 25 MB. Rows with no email are skipped. The response
 * gives counts + the first 10 bad rows so the user can inspect what
 * the server actually parsed.
 */

import { type ReactElement, useEffect, useState } from "react";

import { Modal, ModalFooter } from "../Modal";
import {
  SUPPRESSION_REASONS,
  suppressionsApi,
  type SuppressionImportResult,
} from "../../lib/api-client";
import { beginUploadTransfer, pickImportFiles } from "../../lib/file-transfer";
import type { ImportPolicy } from "../../lib/file-transfer-types";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — matches MaxImportBytes server-side
const SUPPRESSION_IMPORT_POLICY: ImportPolicy = {
  label: "suppression CSV",
  privacy: "confidential",
  extensions: ["csv"],
  maxBytes: MAX_BYTES,
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the import counts when the upload succeeds. */
  onImported: (result: SuppressionImportResult) => void;
}

export function ImportSuppressionsModal({
  open,
  onClose,
  onImported,
}: Props): ReactElement {
  const [file, setFile] = useState<File | null>(null);
  const [defaultReason, setDefaultReason] = useState<string>("manual");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<SuppressionImportResult | null>(null);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setDefaultReason("manual");
      setBusy(false);
      setErr(null);
      setResult(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || (!file && !busy)) return;
    return registerLifecycleGuard({
      id: "suppression-import-draft",
      label: "Suppression import",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : busy
            ? {
                level: "blocking",
                detail: "The suppression CSV is still uploading.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail: "A suppression CSV has been selected but not imported.",
              },
      discard: () => {
        setFile(null);
        setDefaultReason("manual");
        onClose();
      },
    });
  }, [busy, file, onClose, open]);

  function onPickFile(f: File): void {
    setErr(null);
    if (f.size > MAX_BYTES) {
      setErr(
        `File is ${formatBytes(f.size)} — the limit is 25 MB. Split the CSV and import in batches.`,
      );
      return;
    }
    if (
      !/\.csv$|^text\/csv|application\/vnd\.ms-excel/i.test(
        f.type + " " + f.name,
      )
    ) {
      setErr("Please pick a .csv file.");
      return;
    }
    setFile(f);
  }

  async function upload(): Promise<void> {
    if (!file) return;
    setBusy(true);
    setErr(null);
    const transfer = beginUploadTransfer(file, {
      label: "Suppression import",
      privacy: "confidential",
      retry: upload,
    });
    const r = await suppressionsApi.importCsv({
      file,
      defaultReason,
    });
    setBusy(false);
    if (r.error) {
      transfer.fail("suppression_import_failed");
      setErr(r.error.message);
      return;
    }
    if (r.data) {
      transfer.complete();
      setResult(r.data);
      onImported(r.data);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import suppressions"
      description="Upload a CSV with an `email` column. A second `reason` column is optional — rows missing one use the default below."
    >
      {result ? (
        <ImportResultBlock result={result} />
      ) : (
        <PickBlock
          file={file}
          onPickFile={onPickFile}
          defaultReason={defaultReason}
          onChangeDefaultReason={setDefaultReason}
          err={err}
        />
      )}

      <ModalFooter>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          {result ? "Done" : "Cancel"}
        </button>
        {!result ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void upload()}
            disabled={!file || busy}
          >
            {busy ? "Uploading…" : "Import CSV"}
          </button>
        ) : null}
      </ModalFooter>
    </Modal>
  );
}

interface PickBlockProps {
  file: File | null;
  onPickFile: (f: File) => void;
  defaultReason: string;
  onChangeDefaultReason: (s: string) => void;
  err: string | null;
}

function PickBlock({
  file,
  onPickFile,
  defaultReason,
  onChangeDefaultReason,
  err,
}: PickBlockProps): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <button
        type="button"
        style={{
          display: "block",
          width: "100%",
          border: "2px dashed var(--pw-border)",
          borderRadius: 6,
          padding: 24,
          textAlign: "center",
          cursor: "pointer",
          background: "var(--pw-bg-elev-2)",
          color: "var(--pw-fg-muted)",
        }}
        onClick={() => {
          void pickImportFiles(SUPPRESSION_IMPORT_POLICY).then((picked) => {
            if (!picked.ok) return;
            if (picked.files[0]) onPickFile(picked.files[0]);
          });
        }}
      >
        <div style={{ fontSize: 13, color: "var(--pw-fg)" }}>
          {file ? file.name : "Click to choose a CSV file"}
        </div>
        <div style={{ fontSize: 11, marginTop: 4 }}>
          {file
            ? `${formatBytes(file.size)} · email,reason columns auto-detected`
            : "Up to 25 MB. Header optional."}
        </div>
      </button>

      <div className="field">
        <label className="field-label" htmlFor="supp-default-reason">
          Default reason
        </label>
        <select
          id="supp-default-reason"
          className="input"
          value={defaultReason}
          onChange={(e) => onChangeDefaultReason(e.target.value)}
        >
          {SUPPRESSION_REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <div
          className="muted"
          style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}
        >
          Used when a row doesn&apos;t specify its own reason. Existing rows in
          the database keep their reason; we never overwrite.
        </div>
      </div>

      {err ? <div className="field-error">{err}</div> : null}
    </div>
  );
}

function ImportResultBlock({
  result,
}: {
  result: SuppressionImportResult;
}): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
          Import complete
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          Read {(result.bytes_read / 1024).toFixed(1)} KB
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 8,
        }}
      >
        <Stat label="Inserted" value={result.inserted} positive />
        <Stat label="Already existed" value={result.existing} />
        <Stat label="Skipped" value={result.skipped} />
        <Stat
          label="Errors"
          value={result.errors}
          negative={result.errors > 0}
        />
      </div>

      {result.bad_rows && result.bad_rows.length > 0 ? (
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
            Bad rows (first {result.bad_rows.length})
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
            {result.bad_rows.map((row, i) => (
              <div key={i} style={{ color: "var(--pw-fg-muted)" }}>
                {row}
              </div>
            ))}
          </div>
        </div>
      ) : null}
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

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(1)}MB`;
}
