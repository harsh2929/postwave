/**
 * AnalyticsNlqBar — natural-language analytics query input.
 *
 * Mirrors the audit NLQ bar's UX (src/components/audit/AuditNLQBar):
 * ask in English, Claude resolves the question to ONE of a fixed set
 * of saved analytics templates server-side, and the resolved template
 * + params are always echoed back ("interpreted as …") so the
 * operator sees exactly what was queried — no hidden LLM black box.
 *
 * Differences from the audit bar, by design:
 * - There is no cost-status probe endpoint for analytics NLQ, so the
 *   bar renders optimistically and collapses to a one-line explainer
 *   only after the server answers 503 nlq_unavailable.
 * - Answers render inline (table or prose) instead of driving an
 *   external list's filter.
 *
 * Honest error states: 422 invalid_template → "couldn't map that
 * question — try rephrasing"; 429 cost_cap_exceeded → daily budget
 * spent, resets at UTC midnight; 503 → not configured. All inline,
 * never a toast (the answer area is right here).
 */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- the horizontally scrollable result table must be keyboard-focusable */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type AnalyticsNlqResponse,
  analyticsNlqApi,
} from "../../lib/api-client";
import { remoteFailureFromError } from "../../lib/remote-resource";
import { InlineHelp } from "../InlineHelp";
import {
  interpretedAsLine,
  isNlqUnavailable,
  nlqCellText,
  nlqColumnLabel,
  nlqErrorMessage,
  nlqProgressCopy,
} from "./analytics-nlq";

const PLACEHOLDER =
  "Ask anything: 'top campaigns by revenue in the last 30 days', " +
  "'how did opens trend this week?', 'which links got the most clicks?'";
const MAX_QUESTION_LENGTH = 2000;

export function AnalyticsNlqBar(): ReactElement {
  const privacyNoteId = useId();
  const requestRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<AnalyticsNlqResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    return () => {
      requestGenerationRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, []);

  // Advance the staged progress copy once per second while in flight.
  useEffect(() => {
    if (!loading || startedAt == null) return;
    setElapsedMs(0);
    const id = window.setInterval(
      () => setElapsedMs(Date.now() - startedAt),
      1000,
    );
    return () => window.clearInterval(id);
  }, [loading, startedAt]);

  const submit = useCallback(async (): Promise<void> => {
    const q = question.trim();
    if (!q || loading) return;
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setStartedAt(Date.now());
    setError(null);
    setResult(null);
    try {
      const res = await analyticsNlqApi.query(q, {
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        requestGenerationRef.current !== generation
      ) {
        return;
      }
      if (res.error) {
        if (isNlqUnavailable(res.error)) setUnavailable(true);
        setError(nlqErrorMessage(res.error));
        return;
      }
      setResult(res.data);
    } catch {
      if (
        !controller.signal.aborted &&
        requestGenerationRef.current === generation
      ) {
        setError(remoteFailureFromError({ kind: "network" }).message);
      }
    } finally {
      if (requestGenerationRef.current === generation) {
        requestRef.current = null;
        setLoading(false);
        setStartedAt(null);
      }
    }
  }, [question, loading]);

  const cancel = useCallback((): void => {
    requestGenerationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    setLoading(false);
    setStartedAt(null);
    setError(null);
  }, []);

  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  if (unavailable) {
    // Permanent server-side gap (no ANTHROPIC_API_KEY) — collapse to a
    // single honest line instead of re-offering a broken input.
    return (
      <div className="card" style={{ marginTop: 12, padding: "10px 16px" }}>
        <span className="muted" style={{ fontSize: 12 }}>
          Ask-Claude analytics queries aren&apos;t configured on this server —
          the API is running without an Anthropic key.
        </span>
      </div>
    );
  }

  return (
    <div
      className="card"
      style={{
        marginTop: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
      data-testid="analytics-nlq-bar"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden="true"
          style={{ fontSize: 13, color: "var(--pw-fg-muted)" }}
        >
          AI
        </span>
        <span className="section-title" style={{ marginBottom: 0 }}>
          Ask with fixed-query AI
        </span>
        <InlineHelp text="Anthropic translates only your question into one fixed Moosewave query. Moosewave runs that query locally and never sends its result rows back to the model. The selected query and parameters are shown under every answer." />
        {result ? (
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: "auto" }}
            onClick={() => {
              setResult(null);
              setError(null);
              setQuestion("");
            }}
          >
            Clear answer
          </button>
        ) : null}
      </div>

      <p
        id={privacyNoteId}
        className="muted"
        role="note"
        style={{ margin: 0, fontSize: 11, lineHeight: 1.5 }}
      >
        Your question text is sent to Anthropic to choose a fixed query. Result
        rows stay inside Moosewave. Do not include personal, secret, or client
        confidential data in the question.
      </p>

      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={onKey}
        placeholder={PLACEHOLDER}
        rows={2}
        maxLength={MAX_QUESTION_LENGTH}
        disabled={loading}
        style={{
          width: "100%",
          minHeight: 44,
          padding: 8,
          borderRadius: 6,
          border: "1px solid var(--pw-border)",
          background: "var(--pw-bg-elev)",
          color: "var(--pw-fg)",
          fontFamily: "inherit",
          fontSize: 13,
          resize: "vertical",
        }}
        aria-label="Natural-language analytics query"
        aria-describedby={privacyNoteId}
        data-testid="analytics-nlq-input"
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={loading || !question.trim()}
          onClick={() => void submit()}
          data-testid="analytics-nlq-submit"
        >
          {loading ? "Asking…" : "Ask"}
        </button>
        {loading ? (
          <button type="button" className="btn btn-sm" onClick={cancel}>
            Cancel request
          </button>
        ) : null}
        {loading ? (
          <span className="muted" style={{ fontSize: 11 }} aria-live="polite">
            {nlqProgressCopy(elapsedMs)}
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 11 }}>
            Cmd/Ctrl-Enter to submit
          </span>
        )}
        <span
          className="muted tabular"
          style={{ marginLeft: "auto", fontSize: 10 }}
          aria-live="polite"
        >
          {question.length.toLocaleString()} /{" "}
          {MAX_QUESTION_LENGTH.toLocaleString()}
        </span>
      </div>

      {error ? (
        <div className="notice" role="alert">
          <span>{error}</span>
        </div>
      ) : null}

      {result ? <NlqAnswer result={result} /> : null}
    </div>
  );
}

/* ---------- answer rendering ----------------------------------------- */

function NlqAnswer({ result }: { result: AnalyticsNlqResponse }): ReactElement {
  const hasTable =
    result.answer_kind === "table" &&
    result.columns.length > 0 &&
    result.rows.length > 0;

  return (
    <div
      style={{
        borderTop: "1px solid var(--pw-border)",
        paddingTop: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
      data-testid="analytics-nlq-answer"
    >
      {/* summary_text is always shown — for table answers it's the
       * prose framing above the numbers; for summary answers it IS
       * the answer. */}
      {result.summary_text ? (
        <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--pw-fg)" }}>
          {result.summary_text}
        </div>
      ) : null}

      {hasTable ? (
        <div
          role="region"
          aria-label="Natural-language analytics result table"
          tabIndex={0}
          style={{ overflowX: "auto" }}
        >
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
          >
            <thead>
              <tr>
                {result.columns.map((c) => (
                  <th
                    key={c}
                    style={{
                      textAlign: "left",
                      padding: "6px 8px",
                      borderBottom: "1px solid var(--pw-border)",
                      color: "var(--pw-fg-subtle)",
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {nlqColumnLabel(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i}>
                  {result.columns.map((c) => (
                    <td
                      key={c}
                      className="tabular"
                      style={{
                        padding: "6px 8px",
                        borderBottom: "1px solid var(--pw-border)",
                        color: "var(--pw-fg)",
                      }}
                    >
                      {nlqCellText(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : result.answer_kind === "table" ? (
        <div className="pw-chart-empty">
          The query matched no rows in this window.
        </div>
      ) : null}

      {/* Honest provenance: the template + params that were ACTUALLY
       * queried (may be narrower than the question asked). */}
      <div className="muted" style={{ fontSize: 11 }}>
        {interpretedAsLine(result)}
      </div>
      {result.trace?.reasoning ? (
        <div className="muted" style={{ fontSize: 11 }}>
          Query-selection rationale: {result.trace.reasoning}
        </div>
      ) : null}
    </div>
  );
}
