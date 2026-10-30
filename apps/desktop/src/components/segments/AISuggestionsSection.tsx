/**
 * AISuggestionsSection — the "AI suggestions" gallery on the Segments
 * page (SUB-065 cohort discovery).
 *
 * Backend surface consumed (apps/api/internal/segments/ai_suggester.go):
 *   GET /api/v1/segments/ai-suggestions → {items[], generated, notice}
 *
 * Each suggestion carries a ready-to-execute predicate_json AST. The
 * "Use as segment" action hands that AST to the NaturalLanguageBuilder
 * (via onUse) so the operator lands on the compiled predicate + name
 * input directly — no recompile step — and reviews before saving.
 *
 * The server labels these "heuristic" today (heuristic-v1 engine); we
 * surface its `notice` verbatim as a disclosure banner above the cards
 * so we don't overclaim an LLM that isn't running yet.
 *
 * Positioned in the Segments full-surface hierarchy AFTER RFMSection:
 *   saved table → overlap/growth → recipes → RFM & predictive →
 *   **AI suggestions** → NL builder modal.
 */

import { type ReactElement, useEffect, useState } from "react";

import { SectionHeader } from "../SectionHeader";
import { type AISuggestion, segmentsClient } from "./segmentsClient";
import { parseAISuggestions } from "./ai-suggestions-contract";

interface Props {
  /** Editor+ can turn a suggestion into a saved segment. */
  canMutate: boolean;
  /** Seed the NL builder with a suggestion's compiled AST + name. */
  onUse: (suggestion: AISuggestion) => void;
}

/** Maps the backend `category` to a CSS-var tone for the badge. Falls
 *  back to the neutral border when a category is unrecognised so a new
 *  server-side category never renders an empty/garish chip. */
function categoryTone(category: string): string {
  switch (category) {
    case "lifecycle":
      return "var(--pw-info, var(--pw-accent))";
    case "engagement":
      return "var(--pw-warning)";
    case "predictive":
      return "var(--pw-accent)";
    case "consent":
      return "var(--pw-success)";
    default:
      return "var(--pw-fg-subtle)";
  }
}

export function AISuggestionsSection({
  canMutate,
  onUse,
}: Props): ReactElement {
  const [items, setItems] = useState<AISuggestion[] | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    const res = await segmentsClient.aiSuggestions();
    const payload = parseAISuggestions(res.data);
    if (res.error || !payload) {
      setErr(res.error?.message ?? "The suggestions response was invalid");
      setItems(null);
      setNotice("");
    } else {
      setItems(payload.items);
      setNotice(payload.notice);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <section style={{ marginTop: 28 }}>
      <SectionHeader
        title="AI suggestions"
        description="Segment ideas ranked by what's in your data right now — engagement, value, churn risk, consent. One click seeds the builder with the compiled rule."
        helpText="Suggestions are computed when this section loads. Estimated sizes are live counts via the preview path; review the compiled rule before saving."
        actions={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        }
      />

      {!canMutate ? (
        <p
          id="ai-segment-suggestions-write-reason"
          className="muted"
          style={{ fontSize: 11, margin: "0 0 10px" }}
        >
          Viewer access can inspect suggestions but cannot create segments.
        </p>
      ) : null}

      {notice ? (
        <div
          className="muted"
          style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.45 }}
        >
          {notice}
        </div>
      ) : null}

      {err ? (
        <div className="notice" role="alert">
          <span>Couldn&apos;t load suggestions: {err}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
            style={{ marginLeft: "auto" }}
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <div style={{ padding: 12 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="skel-row" />
          ))}
        </div>
      ) : (items?.length ?? 0) === 0 ? (
        <div className="pw-chart-empty">
          No suggestions yet — they appear as engagement, value, and consent
          signals accumulate in your data.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          {items!.map((s) => (
            <div
              key={s.key}
              className="card"
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  justifyContent: "space-between",
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</div>
                {s.category ? (
                  <span
                    style={{
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      fontWeight: 600,
                      padding: "2px 6px",
                      borderRadius: 4,
                      whiteSpace: "nowrap",
                      color: categoryTone(s.category),
                      background: `color-mix(in srgb, ${categoryTone(
                        s.category,
                      )} 14%, transparent)`,
                    }}
                  >
                    {s.category}
                  </span>
                ) : null}
              </div>
              <div
                className="muted"
                style={{ fontSize: 12, lineHeight: 1.45, flex: 1 }}
              >
                {s.description}
              </div>
              <div className="tabular" style={{ fontSize: 12 }}>
                <strong>{s.estimated_size.toLocaleString()}</strong>{" "}
                <span className="muted">
                  subscriber{s.estimated_size === 1 ? "" : "s"} match
                </span>
              </div>
              {s.rationale ? (
                <div
                  className="muted"
                  style={{ fontSize: 11, lineHeight: 1.4, fontStyle: "italic" }}
                >
                  {s.rationale}
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    if (!canMutate) return;
                    onUse(s);
                  }}
                  aria-disabled={!canMutate || undefined}
                  aria-describedby={
                    !canMutate
                      ? "ai-segment-suggestions-write-reason"
                      : undefined
                  }
                >
                  Use as segment
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
