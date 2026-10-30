/**
 * FormsStatStrip — 4 KPIs that summarise the tenant's signup-form
 * health. Computed entirely from the list-forms response so the strip
 * paints as soon as the page loads.
 *
 *   • Forms        — total count, plus a drilldown of draft/archived
 *   • Published    — what's actually live + capturing right now
 *   • 30-day subs  — sum of submissions30d across all forms
 *   • Conversion   — visit-weighted aggregate (Σ subs ÷ Σ visits) when
 *                    enough rows carry visits30d; otherwise the labeled
 *                    unweighted per-form mean (see form-metrics.ts)
 *
 * No coloured side rails. KPI colour comes through the value text and,
 * for the published card, a small leading dot.
 */

import type { ReactElement } from "react";

import type { FormSummary } from "../../lib/api-client";
import { computeAggregateConversion } from "./form-metrics";

interface Props {
  rows: FormSummary[] | null;
}

export function FormsStatStrip({ rows }: Props): ReactElement {
  const loading = rows === null;
  const safe = rows ?? [];
  const total = safe.length;
  const draft = safe.filter((r) => (r.status ?? "draft") === "draft").length;
  const published = safe.filter((r) => r.status === "published").length;
  const archived = safe.filter((r) => r.status === "archived").length;
  const totalSubs30d = safe.reduce(
    (sum, r) => sum + (r.submissions30d ?? 0),
    0,
  );

  // Conversion KPI: visit-weighted (Σ submissions ÷ Σ visits) when
  // visits30d is present on enough rows, else the labeled unweighted
  // per-form mean. The old "weight by submissions" approach weighted
  // each rate by its own numerator and systematically inflated the KPI
  // (e.g. 25.5% true → ~49% shown) — form-metrics.ts owns the rules.
  const conv = computeAggregateConversion(safe);
  const convRate = conv.mode === "empty" ? 0 : conv.rate;
  const weighted = conv.mode === "weighted";

  const publishedColor =
    published > 0 ? "var(--pw-accent)" : "var(--pw-warning)";

  return (
    <div className="stat-grid" style={{ marginBottom: 12 }}>
      <div className="stat-card">
        <div className="stat-label">Forms</div>
        <div className="stat-value tabular">
          {loading ? "—" : total.toLocaleString()}
        </div>
        <div className="stat-delta subtle">
          {loading
            ? "Loading forms…"
            : total === 0
              ? "Create your first form"
              : `${draft} draft · ${archived} archived`}
        </div>
      </div>

      <div className="stat-card" style={{ position: "relative" }}>
        <div className="stat-label">Published</div>
        <div
          className="stat-value tabular"
          style={{
            color: publishedColor,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: publishedColor,
              flexShrink: 0,
            }}
          />
          {loading ? "—" : published.toLocaleString()}
        </div>
        <div className="stat-delta subtle">
          {loading
            ? "Counting published forms…"
            : published > 0
              ? "Live and capturing subscribers"
              : "Publish a draft to start capturing"}
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-label">30-day subs</div>
        <div className="stat-value tabular">
          {loading ? "—" : totalSubs30d.toLocaleString()}
        </div>
        <div className="stat-delta subtle">
          {loading
            ? " "
            : totalSubs30d > 0
              ? "Submissions across all forms"
              : "No signups in the last 30 days"}
        </div>
      </div>

      <div className="stat-card">
        <div
          className="stat-label"
          title={
            weighted
              ? "Total submissions ÷ total hosted-page visits (30 days) across forms reporting visits"
              : "Unweighted mean across forms — a complete, comparable hosted-visit denominator is unavailable"
          }
        >
          {weighted ? "Conversion (30d)" : "Avg conversion / form"}
        </div>
        <div
          className="stat-value tabular"
          style={{
            color:
              convRate >= 5
                ? "var(--pw-accent)"
                : convRate > 0
                  ? "var(--pw-fg)"
                  : "var(--pw-fg-muted)",
          }}
        >
          {loading ? "—" : `${convRate.toFixed(1)}%`}
        </div>
        <div className="stat-delta subtle">
          {loading
            ? "Calculating…"
            : conv.mode === "weighted"
              ? `Visit-weighted · ${conv.submissions.toLocaleString()} subs / ${conv.visits.toLocaleString()} visits${
                  conv.covered < conv.total
                    ? ` · ${conv.covered} of ${conv.total} forms report visits`
                    : ""
                }`
              : conv.mode === "unweighted" && convRate > 0
                ? `Unweighted mean · ${
                    convRate >= 5 ? "above" : "below"
                  } the 5% baseline · comparable visit denominator unavailable`
                : "Need visits + submissions to score"}
        </div>
      </div>
    </div>
  );
}
