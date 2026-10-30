/**
 * AuditNLQBar — natural-language audit query input.
 *
 * Ask anything in English; Claude translates to a structured filter
 * the operator sees verbatim before any results are rendered
 * (CloudTrail Lake pattern: no hidden LLM black box on a compliance
 * surface). Async submit with loading + error toast; disabled when
 * the per-tenant daily cost cap is hit or the API hasn't been wired
 * with an Anthropic key.
 *
 * natural-language-query feature, audit gap-doc UX P0.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type AuditNLQCostStatus,
  type AuditNLQResponse,
  api,
} from "../../lib/api-client";
import { InlineHelp } from "../InlineHelp";
import { toast } from "../Toast";

interface Props {
  onResult: (result: AuditNLQResponse) => void;
  onClear: () => void;
  active: boolean;
}

const PLACEHOLDER =
  "Ask anything: 'who deleted subscribers in the last day?', 'show me api_key logins this week', 'all exports'";

/**
 * useAuditNLQQuery — encapsulates the async submission lifecycle.
 * Exposed as a hook so a future surface (e.g. a slash-command on a
 * different page) can reuse the same state machine.
 */
export function useAuditNLQQuery(): {
  query: string;
  setQuery: (q: string) => void;
  loading: boolean;
  submit: (q: string) => Promise<AuditNLQResponse | null>;
  costStatus: AuditNLQCostStatus | null;
  nlqAvailable: boolean;
  refreshCost: () => Promise<void>;
} {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [costStatus, setCostStatus] = useState<AuditNLQCostStatus | null>(null);
  const [nlqAvailable, setNlqAvailable] = useState(true);

  const refreshCost = useCallback(async (): Promise<void> => {
    const res = await api.apiAuditNLQCostStatus();
    if (res.error) {
      // 503 nlq_unavailable / 401 — hide the bar gracefully.
      if (res.error.code === "nlq_unavailable") setNlqAvailable(false);
      return;
    }
    setCostStatus(res.data);
    if (typeof res.data.nlq_available === "boolean")
      setNlqAvailable(res.data.nlq_available);
  }, []);

  useEffect(() => {
    void refreshCost();
  }, [refreshCost]);

  const submit = useCallback(
    async (q: string): Promise<AuditNLQResponse | null> => {
      const trimmed = q.trim();
      if (!trimmed) {
        toast.error("Type a question first.");
        return null;
      }
      setLoading(true);
      try {
        const res = await api.apiAuditNLQ(trimmed);
        if (res.error) {
          if (res.error.code === "cost_cap_exceeded") {
            toast.error(
              "Daily NLQ budget exhausted. Resets at UTC midnight.",
            );
            void refreshCost();
          } else if (res.error.code === "nlq_unavailable") {
            setNlqAvailable(false);
            toast.error("NLQ is not configured on this server.");
          } else if (res.error.code === "nlq_bad_translation") {
            toast.error(
              "Claude returned an unparseable answer — try rephrasing.",
            );
          } else {
            toast.error(res.error.message || "NLQ query failed.");
          }
          return null;
        }
        setCostStatus(res.data.cost_status);
        return res.data;
      } finally {
        setLoading(false);
      }
    },
    [refreshCost],
  );

  return {
    query,
    setQuery,
    loading,
    submit,
    costStatus,
    nlqAvailable,
    refreshCost,
  };
}

export function AuditNLQBar({
  onResult,
  onClear,
  active,
}: Props): ReactElement | null {
  const {
    query,
    setQuery,
    loading,
    submit,
    costStatus,
    nlqAvailable,
  } = useAuditNLQQuery();
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Cmd/Ctrl-Enter submits — auditors are keyboard-heavy.
  const onKey = useCallback(
    async (e: React.KeyboardEvent<HTMLTextAreaElement>): Promise<void> => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        const r = await submit(query);
        if (r) onResult(r);
      }
    },
    [submit, query, onResult],
  );

  if (!nlqAvailable) {
    // Hide the bar entirely rather than render a disabled stub — a
    // compliance surface with a permanently-disabled AI input invites
    // the question "why is this here?".
    return null;
  }

  const remaining = costStatus?.remaining_tokens;
  const cap = costStatus?.daily_cap_tokens;
  const lowBudget =
    typeof remaining === "number" &&
    typeof cap === "number" &&
    cap > 0 &&
    remaining > 0 &&
    remaining < cap / 10;
  const exhausted =
    typeof remaining === "number" && cap !== undefined && cap > 0 && remaining <= 0;

  return (
    <div
      className="audit-nlq-bar"
      style={{
        background: "var(--pw-bg-elev-2)",
        borderRadius: 8,
        padding: 12,
        marginBottom: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
      data-testid="audit-nlq-bar"
    >
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <span
          aria-hidden="true"
          style={{ fontSize: 14, color: "var(--pw-fg-muted)" }}
        >
          AI
        </span>
        <strong style={{ fontSize: 13 }}>Ask Claude</strong>
        <InlineHelp text="Translates your question into a structured filter (which you'll see before any results). Cached for an hour per tenant." />
        {active ? (
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: "auto" }}
            onClick={() => {
              setQuery("");
              onClear();
            }}
          >
            Clear AI query
          </button>
        ) : null}
      </div>
      <textarea
        ref={taRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => void onKey(e)}
        placeholder={PLACEHOLDER}
        rows={2}
        maxLength={2000}
        disabled={loading || exhausted}
        style={{
          width: "100%",
          minHeight: 44,
          padding: 8,
          borderRadius: 6,
          border: "1px solid var(--pw-border)",
          fontFamily: "inherit",
          fontSize: 13,
          resize: "vertical",
        }}
        aria-label="Natural-language audit query"
        data-testid="audit-nlq-input"
      />
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={loading || !query.trim() || exhausted}
          onClick={() => {
            void (async () => {
              const r = await submit(query);
              if (r) onResult(r);
            })();
          }}
          data-testid="audit-nlq-submit"
        >
          {loading ? "Asking Claude…" : "Ask"}
        </button>
        <span className="muted small" style={{ fontSize: 11 }}>
          Cmd/Ctrl-Enter to submit
        </span>
        {costStatus && typeof cap === "number" && cap > 0 ? (
          <span
            className="muted small tabular"
            style={{
              marginLeft: "auto",
              color: exhausted
                ? "var(--pw-danger)"
                : lowBudget
                  ? "var(--pw-warning)"
                  : "var(--pw-fg-muted)",
              fontSize: 11,
            }}
            title={`Resets at ${costStatus.reset_at}`}
          >
            {exhausted
              ? "Daily NLQ budget exhausted"
              : `${remaining?.toLocaleString() ?? "—"} / ${cap.toLocaleString()} tokens left today`}
          </span>
        ) : null}
      </div>
    </div>
  );
}
