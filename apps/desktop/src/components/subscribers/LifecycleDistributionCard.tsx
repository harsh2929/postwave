/**
 * LifecycleDistributionCard — compact tenant-wide lifecycle rollup for
 * the Subscribers page (#17): GET /lifecycle/distribution merged with
 * the GET /lifecycle/stages catalog so empty stages still render.
 *
 * HONEST-UI DECISION: this card is informational only. The page's
 * filter model is {status chip, free-text q} — the subscribers list
 * endpoint takes no lifecycle param and the loaded rows don't carry a
 * stage, so clicking a stage cannot apply a real filter. Rather than
 * fake one client-side over data we don't have, the card says where
 * stages are edited (the per-subscriber detail panel) and stays a
 * read-only rollup.
 */

import { type ReactElement, useEffect, useState } from "react";

import { lifecycleRollupApi } from "../../lib/api-client";
import { CategoricalDistributionChart } from "../charts/CategoricalDistributionChart";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";
import {
  type LifecycleDistributionView,
  buildLifecycleView,
} from "./subscriber-insights";

function stageLabel(stage: string): string {
  // A null/empty stage (the catalog or distribution row could omit it
  // despite the non-optional wire type) renders "—" rather than
  // crashing on `.length`/`.split`.
  const s = stage ?? "";
  if (s === "") return "—";
  // mql/sql read better fully uppercased; everything else title-case.
  if (s.length <= 3 && s !== "lead") return s.toUpperCase();
  return s
    .split("_")
    .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join(" ");
}

/** Deterministic per-stage hue so category colors stay stable across reloads. */
function stageHue(stage: string): number {
  const s = stage ?? "";
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

export function LifecycleDistributionCard(): ReactElement | null {
  const [view, setView] = useState<LifecycleDistributionView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);

  // Extracted so the error state's Retry button can re-trigger the
  // load; `reloadTick` keeps the effect (and its cancellation guard)
  // as the single fetch path.
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setUnavailable(false);
    setView(null);
    void (async () => {
      try {
        const [dist, stages] = await Promise.all([
          lifecycleRollupApi.distribution(),
          lifecycleRollupApi.stages(),
        ]);
        if (cancelled) return;
        setLoading(false);
        if (dist.error) {
          // 404 = routes not mounted on this deployment — hide rather
          // than nag; anything else is a real failure worth a line.
          if (dist.error.kind === "http" && dist.error.status === 404) {
            setUnavailable(true);
          } else {
            setErr(dist.error.message);
          }
          return;
        }
        // The stage catalog is decoration (ordering + zero-fill); a
        // failed stages call degrades to distribution-only ordering.
        const items = dist.data.items;
        const catalog = stages.data?.stages;
        setView(
          buildLifecycleView(
            Array.isArray(items) ? items : [],
            Array.isArray(catalog) ? catalog : [],
          ),
        );
      } catch (requestError) {
        if (cancelled) return;
        setLoading(false);
        setErr(
          requestError instanceof Error
            ? requestError.message
            : "Lifecycle distribution request failed.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  if (unavailable) return null;

  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: "8px 10px",
        marginBottom: 12,
        background: "var(--pw-bg-elev)",
      }}
      role="region"
      aria-label="Lifecycle distribution"
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>
          Lifecycle distribution
        </span>
        {view ? (
          <span className="muted tabular" style={{ fontSize: 11 }}>
            {(view.total ?? 0).toLocaleString()} staged subscriber
            {view.total === 1 ? "" : "s"}
          </span>
        ) : null}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 11 }}>
          Read-only rollup — the list can&apos;t filter by stage yet; edit a
          stage from a subscriber&apos;s detail panel.
        </span>
      </div>

      {loading ? (
        <div role="status" aria-label="Loading lifecycle distribution">
          <div className="skel" style={{ height: 22 }} aria-hidden="true" />
        </div>
      ) : err ? (
        <div
          style={{ display: "flex", alignItems: "center", gap: 8 }}
          role="alert"
        >
          <span className="muted" style={{ fontSize: 12 }}>
            Couldn&apos;t load lifecycle distribution: {err}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setReloadTick((t) => t + 1)}
          >
            Retry
          </button>
        </div>
      ) : view && view.total === 0 ? (
        <div className="muted" style={{ fontSize: 12 }} role="status">
          No subscribers have a lifecycle stage yet.
        </div>
      ) : view ? (
        <CategoricalDistributionChart
          title="Subscriber lifecycle-stage distribution"
          valueLabel="Staged subscribers"
          height={10}
          segments={(Array.isArray(view.rows) ? view.rows : []).map(
            (row, index) => ({
              key: row.stage || `stage-${index}`,
              label: stageLabel(row.stage),
              value: row.count ?? 0,
              color:
                (row.count ?? 0) > 0
                  ? `hsl(${stageHue(row.stage)} 55% 50%)`
                  : "var(--pw-bg-elev-2)",
            }),
          )}
          provenance={dux025Provenance("lifecycleDistribution", {
            scope: `Current workspace · ${view.total.toLocaleString()} staged subscribers`,
          })}
          exportFileName="subscriber-lifecycle-stage-distribution.csv"
          exportPrivacy="confidential"
        />
      ) : null}
    </div>
  );
}
