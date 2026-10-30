/**
 * AuditNLQSummary — result card for a natural-language audit query.
 *
 * Three sections (CloudTrail Lake pattern):
 *   1. Summary — 1-2 sentence Claude-generated paragraph.
 *   2. Structured filter preview — read-only chips so the operator
 *      sees exactly the filter Claude translated to. Copy / Apply
 *      buttons to either grab the JSON or push the filter into the
 *      page's main filter bar.
 *   3. "Why this answer?" expander — reveals the LLM trace
 *      (reasoning + model + raw response + token counts) so an
 *      auditor can spot a hallucinated translation.
 *
 * natural-language-query feature, audit gap-doc UX P0.
 */

import { type ReactElement, useState } from "react";

import type {
  AuditNLQResponse,
  AuditNLQStructuredFilters,
} from "../../lib/api-client";
import { writeClipboardText } from "../../lib/clipboard";
import { saveFile } from "../../lib/file-transfer";
import { toast } from "../Toast";

interface Props {
  result: AuditNLQResponse;
  onApplyFilters?: (filters: AuditNLQStructuredFilters) => void;
  onDismiss?: () => void;
}

/**
 * StructuredFilterPreview renders the LLM-translated filter as
 * read-only key/value chips. Empty filters are omitted so the row
 * stays compact.
 */
export function StructuredFilterPreview({
  filters,
}: {
  filters: AuditNLQStructuredFilters;
}): ReactElement {
  const entries: [string, string][] = [];
  if (filters.actor_type) entries.push(["actor_type", filters.actor_type]);
  if (filters.actor_label) entries.push(["actor_label", filters.actor_label]);
  if (filters.action) entries.push(["action", filters.action]);
  if (filters.resource_type)
    entries.push(["resource_type", filters.resource_type]);
  if (filters.resource_id) entries.push(["resource_id", filters.resource_id]);
  if (filters.since) entries.push(["since", filters.since]);
  if (filters.limit) entries.push(["limit", String(filters.limit)]);

  if (entries.length === 0) {
    return (
      <span className="muted small" style={{ fontSize: 11 }}>
        (no filter — Claude returned everything)
      </span>
    );
  }
  return (
    <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
      {entries.map(([k, v]) => (
        <span
          key={k}
          className="chip"
          title={`${k} = ${v}`}
          style={{
            background: "var(--pw-bg-elev-2)",
            border: "1px solid var(--pw-border)",
            borderRadius: 4,
            padding: "2px 6px",
            fontSize: 11,
            fontFamily: "var(--pw-font-mono)",
          }}
        >
          <strong>{k}</strong>={v}
        </span>
      ))}
    </div>
  );
}

/**
 * WhyThisAnswerExpander reveals the LLM trace. Default collapsed —
 * an operator only opens it when something looks wrong.
 */
export function WhyThisAnswerExpander({
  result,
}: {
  result: AuditNLQResponse;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const trace = result.trace;
  const totalTokens =
    trace.prompt_tokens + trace.response_tokens + trace.summary_tokens;

  return (
    <div
      style={{
        marginTop: 8,
        borderTop: "1px solid var(--pw-border)",
        paddingTop: 8,
      }}
    >
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => setOpen((o) => !o)}
        data-testid="audit-nlq-why-toggle"
        aria-expanded={open}
      >
        {open ? "Hide" : "Why this answer?"}
      </button>
      {open ? (
        <div
          style={{
            marginTop: 8,
            background: "var(--pw-bg-elev)",
            border: "1px solid var(--pw-border)",
            borderRadius: 6,
            padding: 10,
            fontSize: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
          data-testid="audit-nlq-why-body"
        >
          <div>
            <strong>Claude reasoning:</strong>{" "}
            <span className="muted">
              {trace.reasoning || "(no reasoning supplied)"}
            </span>
          </div>
          {result.invalid_fields && result.invalid_fields.length > 0 ? (
            <div style={{ color: "var(--pw-warning)" }}>
              <strong>Ignored fields:</strong>{" "}
              {result.invalid_fields.join(", ")} — not in the audit_log schema.
            </div>
          ) : null}
          <div className="muted small tabular" style={{ fontSize: 11 }}>
            Model {trace.model || "claude"} ·{" "}
            {trace.cache_hit
              ? "cache hit (no tokens charged)"
              : `${totalTokens} tokens`}{" "}
            · retention window {trace.retention_days}d · {trace.generated_at}
          </div>
          <details>
            <summary
              style={{ cursor: "pointer", fontSize: 11 }}
              className="muted"
            >
              Raw LLM response
            </summary>
            <pre
              style={{
                marginTop: 6,
                background: "var(--pw-bg-elev-2)",
                padding: 8,
                borderRadius: 4,
                fontSize: 11,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 200,
                overflow: "auto",
              }}
            >
              {trace.raw_llm_response || "(empty)"}
            </pre>
          </details>
        </div>
      ) : null}
    </div>
  );
}

/**
 * NLQResultCard is the headline summary block (sentence + total count).
 * Kept as a separate component so the parent can render it standalone
 * if needed (e.g. in a future "saved NLQ" panel).
 */
export function NLQResultCard({
  result,
}: {
  result: AuditNLQResponse;
}): ReactElement {
  const empty = result.total_count === 0;
  return (
    <div>
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.5,
          color: empty ? "var(--pw-fg-muted)" : "var(--pw-fg)",
        }}
        data-testid="audit-nlq-summary-text"
      >
        {result.summary ||
          (empty
            ? "No events match this query."
            : `${result.total_count.toLocaleString()} matching event${result.total_count === 1 ? "" : "s"}.`)}
      </div>
      <div className="muted small" style={{ fontSize: 11, marginTop: 4 }}>
        {result.total_count.toLocaleString()} total match
        {result.total_count === 1 ? "" : "es"} · showing first{" "}
        {result.results.length.toLocaleString()}
      </div>
    </div>
  );
}

export function AuditNLQSummary({
  result,
  onApplyFilters,
  onDismiss,
}: Props): ReactElement {
  function copyFilters(): void {
    const text = JSON.stringify(result.structured_filters, null, 2);
    writeClipboardText(text, {
      contentClass: "personal",
      label: "Structured audit filter",
    })
      .then((copyResult) => {
        if (copyResult.ok) toast.success("Structured filter copied");
        else toast.error(copyResult.message);
      })
      .catch(() => toast.error("The structured filter couldn't be copied."));
  }
  function downloadFilters(): void {
    void saveFile({
      data: JSON.stringify(result.structured_filters, null, 2),
      suggestedName: "audit-nlq-filters.json",
      label: "Audit query filters",
      privacy: "confidential",
      mimeType: "application/json",
    }).then((saved) => {
      if (!saved.ok) toast.error(saved.message);
    });
  }

  return (
    <div
      className="audit-nlq-summary"
      style={{
        background: "var(--pw-bg-elev)",
        border: "1px solid var(--pw-border)",
        borderRadius: 8,
        padding: 14,
        marginBottom: 10,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
      data-testid="audit-nlq-summary"
    >
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <span
          style={{
            background:
              "color-mix(in srgb, var(--pw-accent) 12%, var(--pw-bg-elev))",
            color: "var(--pw-accent)",
            borderRadius: 4,
            padding: "2px 6px",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.5,
          }}
        >
          AI ANSWER
        </span>
        <span
          className="muted small"
          style={{ fontSize: 11, flex: 1 }}
          title={result.query_preview}
        >
          {result.query_preview.length > 100
            ? `${result.query_preview.slice(0, 100)}…`
            : result.query_preview}
        </span>
        {onDismiss ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onDismiss}
            aria-label="Dismiss NLQ result"
            data-testid="audit-nlq-dismiss"
          >
            ×
          </button>
        ) : null}
      </div>

      <NLQResultCard result={result} />

      <div
        style={{
          background: "var(--pw-bg-elev-2)",
          borderRadius: 6,
          padding: 8,
        }}
      >
        <div
          className="row"
          style={{ alignItems: "center", gap: 8, marginBottom: 6 }}
        >
          <strong style={{ fontSize: 11 }}>Structured filter</strong>
          <span
            className="muted small"
            style={{ fontSize: 10 }}
            title="The exact filter Claude translated your question into. Always shown so you can verify the query before trusting the results."
          >
            (what Claude actually queried)
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {onApplyFilters ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onApplyFilters(result.structured_filters)}
                data-testid="audit-nlq-apply"
              >
                Apply to filters
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm"
              onClick={copyFilters}
              data-testid="audit-nlq-copy"
            >
              Copy JSON
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={downloadFilters}
              data-testid="audit-nlq-download"
            >
              Download
            </button>
          </div>
        </div>
        <StructuredFilterPreview filters={result.structured_filters} />
      </div>

      <WhyThisAnswerExpander result={result} />
    </div>
  );
}
