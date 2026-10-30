import type { ReactElement } from "react";

import type {
  SubscriberImportDryRunResults,
  SubscriberImportPreview,
} from "../../lib/api-client";
import { fmtDateTime, fmtRelative } from "../../lib/format-date";

const ROW_OUTCOME_COPY: Readonly<Record<string, string>> = {
  csv_parse_error: "CSV row could not be parsed.",
  invalid_email: "Email field is missing or invalid.",
  duplicate_in_file: "Duplicate email appears earlier in this file.",
  row_shape_invalid: "Mapped row shape is invalid.",
  tag_budget_exceeded: "Combined row and job tags exceed the allowed budget.",
  custom_field_schema_mismatch: "A mapped custom value does not satisfy its governed field schema.",
  existing_subscriber_conflict: "An existing subscriber conflicts with conflict-free mode.",
};

function safeRowOutcome(code: string | undefined, outcome: string): string {
  if (code && ROW_OUTCOME_COPY[code]) return ROW_OUTCOME_COPY[code];
  if (outcome === "create") return "Would create a protected new profile.";
  if (outcome === "update") return "Would merge safe fields while preserving eligibility.";
  if (outcome === "skip") return "Would leave this row unchanged.";
  return "Row did not satisfy the reviewed import contract.";
}

function safeImportFailure(raw: string | undefined): string {
  const value = raw?.toLowerCase() ?? "";
  if (/duplicate|already exists|unique/.test(value)) {
    return "One or more rows conflict with an existing subscriber.";
  }
  if (/email|invalid address/.test(value)) {
    return "One or more rows contain an invalid email field.";
  }
  if (/field|column|schema|type|mapping/.test(value)) {
    return "One or more rows do not match the reviewed field mapping.";
  }
  if (/preflight|fingerprint|state changed|catalog/.test(value)) {
    return "The reviewed source or workspace state changed before settlement.";
  }
  if (/timeout|deadline|network|connect/.test(value)) {
    return "The import worker could not complete the request.";
  }
  return "The import worker did not complete this job.";
}

export function DryRunResults({
  results,
}: {
  results: SubscriberImportDryRunResults;
}): ReactElement {
  return (
    <section className="subscriber-import-preflight" aria-label="Authoritative preflight results">
      <header>
        <div>
          <span className="subscriber-import-eyebrow">Read-only · exhaustive</span>
          <strong>Authoritative row outcomes</strong>
        </div>
        <time dateTime={results.validated_at}>
          {fmtDateTime(results.validated_at)} · {fmtRelative(results.validated_at)}
        </time>
      </header>
      <div className="subscriber-import-outcome-grid">
        <ImportMetricTile label="Would create" value={results.would_create.toLocaleString()} tone="positive" />
        <ImportMetricTile label="Would update" value={results.would_update.toLocaleString()} />
        <ImportMetricTile label="Would skip" value={results.would_skip.toLocaleString()} />
        <ImportMetricTile label="Would fail" value={results.would_fail.toLocaleString()} tone={results.would_fail ? "danger" : "positive"} />
      </div>
      <p className="subscriber-import-coverage-copy">
        All {results.rows_total.toLocaleString()} rows classified · {results.file_dupes.toLocaleString()} in-file duplicates · {results.would_be_sendable.toLocaleString()} sendable after · {results.would_remain_protected.toLocaleString()} existing protected.
      </p>
      {results.rows.length ? (
        <div className="subscriber-import-row-outcomes">
          <table className="data-table">
            <caption className="visually-hidden">Privacy-safe preflight row outcomes</caption>
            <thead><tr><th scope="col">CSV row</th><th scope="col">Outcome</th><th scope="col">Safe reason</th></tr></thead>
            <tbody>
              {results.rows.map((row) => (
                <tr key={`${row.row_number}:${row.outcome}`}>
                  <td className="tabular">#{row.row_number.toLocaleString()}</td>
                  <td><span className={`subscriber-import-outcome is-${row.outcome}`}>{row.outcome}</span></td>
                  <td>{safeRowOutcome(row.error_code, row.outcome)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {results.detail_capped ? (
        <p className="subscriber-import-detail-note">
          Showing {results.rows.length.toLocaleString()} privacy-safe examples with failures prioritized. Aggregate counts still cover every row.
        </p>
      ) : null}
    </section>
  );
}

export function ImportProgress({
  preview,
}: {
  preview: SubscriberImportPreview;
}): ReactElement {
  const status = preview.status;
  const failed = status === "failed";
  const cancelled = status === "cancelled";
  const done = status === "ready";
  const total = preview.rows_total ?? 0;
  const processed = preview.processed_rows ?? 0;
  const percentage = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : done ? 100 : 0;
  const label = failed
    ? "Import failed"
    : cancelled
      ? "Import cancelled"
      : done
        ? "Import complete"
        : preview.cancel_requested
          ? "Cancellation requested"
          : status === "queued"
            ? "Queued once · waiting for worker"
            : "Importing verified rows";

  return (
    <section className={`subscriber-import-live-progress is-${status}`} aria-label="Subscriber import progress">
      <header><div><span className="subscriber-import-live-dot" aria-hidden="true" /><strong>{label}</strong></div>{total ? <span className="tabular">{processed.toLocaleString()} / {total.toLocaleString()} · {percentage}%</span> : null}</header>
      <progress aria-label={label} max={total || 1} value={total ? Math.min(processed, total) : done ? 1 : 0} />
      <div className="subscriber-import-progress-counts">
        <span><strong>{(preview.rows_imported ?? 0).toLocaleString()}</strong> imported</span>
        <span><strong>{(preview.rows_skipped ?? 0).toLocaleString()}</strong> skipped</span>
        <span><strong>{(preview.rows_failed ?? 0).toLocaleString()}</strong> failed</span>
        <span><strong>{(preview.rows_sendable_after ?? 0).toLocaleString()}</strong> sendable after</span>
        <span><strong>{(preview.rows_protected_existing ?? 0).toLocaleString()}</strong> protected existing</span>
        <span><strong>{(preview.consent_receipts_written ?? 0).toLocaleString()}</strong> receipts</span>
      </div>
      {preview.error ? <div className="subscriber-import-alert is-danger" role="alert"><strong>Worker stopped safely</strong><span>{safeImportFailure(preview.error)}</span></div> : null}
      {preview.last_chunk_at ? <p className="subscriber-import-detail-note">Last verified settlement <time dateTime={preview.last_chunk_at}>{fmtDateTime(preview.last_chunk_at)} · {fmtRelative(preview.last_chunk_at)}</time>.</p> : null}
    </section>
  );
}

export function ImportMetricTile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "positive" | "danger";
}): ReactElement {
  return (
    <div className={`subscriber-import-metric is-${tone}`}>
      <span>{label}</span>
      <strong className="tabular">{value}</strong>
    </div>
  );
}
