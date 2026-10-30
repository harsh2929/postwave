/**
 * PlaygroundHeaders — two related affordances on the playground:
 *
 *   1. CustomHeadersEditor: lets the operator add a bounded set of
 *      portable key/value headers. Idempotency-Key gets
 *      a special row with a "regenerate" button so non-GET requests
 *      always carry a fresh UUID without the user typing one.
 *
 *   2. ResponseHeadersTable: renders the response headers panel
 *      with copy-each-value affordances. Rate-limit + request-id +
 *      ETag headers are the debugging gold the v1 page hid.
 *
 * Both components are headless / structural — styling lives in
 * styles-playground-v2.css.
 */

import { type ReactElement, useId, useState } from "react";

import { CopyButton } from "./Copy";
import { isSensitivePlaygroundHeader } from "./playground-safety";
import { DataTable, type DataTableColumn } from "../table/DataTable";

/* ---------- Request: custom headers --------------------------------- */

export interface CustomHeaderRow {
  key: string;
  value: string;
}

export const PLAYGROUND_CUSTOM_HEADER_MAX_ROWS = 16;
export const PLAYGROUND_CUSTOM_HEADER_NAME_MAX_LENGTH = 128;
export const PLAYGROUND_CUSTOM_HEADER_VALUE_MAX_LENGTH = 8 * 1024;

interface CustomHeadersProps {
  /** The custom headers (excluding the auto-managed Idempotency-Key,
   *  which has its own slot below). */
  rows: CustomHeaderRow[];
  onChange: (rows: CustomHeaderRow[]) => void;
  /** Generated UUID for Idempotency-Key. Empty when the request type
   *  is GET (no idempotency required). */
  idempotencyKey: string;
  /** Trigger a UUID regeneration. */
  onRegenIdempotency: () => void;
  /** When false, the Idempotency-Key row is hidden (GET requests). */
  showIdempotency: boolean;
}

export function CustomHeadersEditor({
  rows,
  onChange,
  idempotencyKey,
  onRegenIdempotency,
  showIdempotency,
}: CustomHeadersProps): ReactElement {
  const fieldId = useId();
  const update = (idx: number, patch: Partial<CustomHeaderRow>): void => {
    const next = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    onChange(next);
  };
  const add = (): void => {
    if (rows.length >= PLAYGROUND_CUSTOM_HEADER_MAX_ROWS) return;
    onChange([...rows, { key: "", value: "" }]);
  };
  const remove = (idx: number): void => {
    onChange(rows.filter((_, i) => i !== idx));
  };

  return (
    <div className="play-headers-editor">
      {showIdempotency ? (
        <div className="play-header-row play-header-row-idem">
          <input
            className="input mono"
            value="Idempotency-Key"
            readOnly
            aria-label="Header name"
            style={{ flex: 1 }}
          />
          <input
            className="input mono"
            value={idempotencyKey}
            readOnly
            aria-label="Idempotency-Key value"
            style={{ flex: 2 }}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={onRegenIdempotency}
            aria-label="Generate a fresh idempotency key"
          >
            Regenerate
          </button>
          <CopyButton
            value={idempotencyKey}
            label="Key"
            compact
            contentClass="secret"
            clearIfUnchangedAfterMs={60_000}
          />
          <span style={{ width: 28 }} aria-hidden="true" />
        </div>
      ) : null}

      {rows.length === 0 && !showIdempotency ? (
        <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          No custom headers. Only portable, non-secret headers are accepted.
        </p>
      ) : null}

      {rows.map((row, idx) => (
        <div key={`${fieldId}-${idx}`} className="play-header-row">
          <input
            className="input mono"
            placeholder="Accept or If-Match"
            value={row.key}
            maxLength={PLAYGROUND_CUSTOM_HEADER_NAME_MAX_LENGTH}
            onChange={(e) => update(idx, { key: e.target.value })}
            aria-label={`Header name ${idx + 1}`}
            style={{ flex: 1 }}
          />
          <input
            className="input mono"
            placeholder="Value"
            value={row.value}
            maxLength={PLAYGROUND_CUSTOM_HEADER_VALUE_MAX_LENGTH}
            onChange={(e) => update(idx, { value: e.target.value })}
            aria-label={`Header value ${idx + 1}`}
            style={{ flex: 2 }}
          />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => remove(idx)}
            aria-label={`Remove header ${row.key || idx + 1}`}
          >
            ×
          </button>
        </div>
      ))}

      <div className="row" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={add}
          disabled={rows.length >= PLAYGROUND_CUSTOM_HEADER_MAX_ROWS}
        >
          + Add header
        </button>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 11 }}>
          Accept or If-Match only · {rows.length}/
          {PLAYGROUND_CUSTOM_HEADER_MAX_ROWS}. Authorization stays
          transport-owned.
        </span>
      </div>
    </div>
  );
}

/* ---------- Response headers panel ---------------------------------- */

interface ResponseHeadersProps {
  /** Map of header name -> value. Casing as returned by the server. */
  headers: Record<string, string>;
}

export function ResponseHeadersTable({
  headers,
}: ResponseHeadersProps): ReactElement {
  const entries = Object.entries(headers).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const columns: readonly DataTableColumn<[string, string]>[] = [
    {
      id: "header",
      header: "Header",
      width: "220px",
      cell: ([key]) => <span className="play-resp-header-name">{key}</span>,
    },
    {
      id: "value",
      header: "Value",
      width: "360px",
      cell: ([key, value]) => <ResponseHeaderValue name={key} value={value} />,
    },
    {
      id: "actions",
      header: <span className="visually-hidden">Actions</span>,
      align: "end",
      cell: ([key, value]) => (
        <CopyButton
          value={value}
          label={`${key} value`}
          compact
          contentClass={
            isSensitivePlaygroundHeader(key) ? "secret" : "personal"
          }
          clearIfUnchangedAfterMs={
            isSensitivePlaygroundHeader(key) ? 60_000 : undefined
          }
        />
      ),
    },
  ];
  return (
    <DataTable
      caption="Response headers"
      description="Header names and values returned by the latest request. Sensitive values use secret clipboard handling."
      columns={columns}
      rows={entries}
      getRowKey={([key]) => key}
      emptyState="No response headers."
      density="compact"
    />
  );
}

function ResponseHeaderValue({
  name,
  value,
}: {
  name: string;
  value: string;
}): ReactElement {
  const sensitive = isSensitivePlaygroundHeader(name);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  if (!sensitive) {
    return <span className="play-resp-header-value">{value}</span>;
  }
  const revealed = revealedValue === value;
  return (
    <span className="play-resp-header-sensitive">
      <span className="play-resp-header-value">
        {revealed ? value : "••••••••"}
      </span>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        aria-pressed={revealed}
        onClick={() =>
          setRevealedValue((current) => (current === value ? null : value))
        }
      >
        {revealed ? "Hide" : "Reveal"} {name}
      </button>
    </span>
  );
}

/* ---------- helpers ------------------------------------------------- */

/**
 * Cheap UUIDv4 generator. crypto.randomUUID is the default; falls
 * back to a Math.random()-based v4 for browsers without it (still
 * fine for an idempotency key — the value just needs to be unique
 * per request, not cryptographically random).
 */
export function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    try {
      return (crypto as Crypto & { randomUUID: () => string }).randomUUID();
    } catch {
      /* fall through */
    }
  }
  // RFC 4122 v4 from Math.random — adequate for idempotency keys.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
