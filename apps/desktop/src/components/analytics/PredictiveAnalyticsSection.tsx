/**
 * PredictiveAnalyticsSection — the Analytics page's marketer-facing
 * "Predictive analytics" surface (Klaviyo-parity KLV-07: predictive
 * CLV / RFM / benchmarks).
 *
 * Backend surfaces consumed (apps/api/internal/predictive), all via
 * predictiveApi (already wired in api-client):
 *   GET  /api/v1/predictive/profiles      capped prediction + RFM pairs
 *   GET  /api/v1/predictive/catalog       model + RFM-segment catalog
 *   POST /api/v1/predictive/recompute     admin, synchronous model run
 *
 * Three honest sections in one card group:
 *   1. CLV summary — aggregate historic / predicted / total CLV across
 *      the loaded slice.
 *   2. Top predictive profiles — sortable by predicted value or churn
 *      risk, with per-row confidence + data_sufficiency.
 *   3. RFM groups report — per-segment subscriber counts.
 *
 * Honesty rules (this is the POINT of KLV-07 acceptance):
 *   - Predicted/projected figures carry <EstimateBadge>; historic CLV
 *     (real order history) and RFM (computed from orders) do NOT.
 *   - Confidence + data_sufficiency are ALWAYS surfaced on predictions,
 *     never hidden; <ConfidenceNote level="low"> shows only when the
 *     server itself reports weak data.
 *   - Benchmarks are FIRST-PARTY (this tenant's own data) only — we
 *     never fabricate an "industry average". Stated explicitly.
 *   - The recompute total `scored_profiles` is the only honest M for the
 *     loaded-slice fraction; we omit the fraction otherwise.
 *
 * This is a NEW surface — it does NOT move or replace the Segments-page
 * RFMSection. Recompute + data-gap patterns mirror that section but the
 * component is its own.
 */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- the horizontally scrollable predictive-profile table must be keyboard-focusable */

import {
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type PredictiveCatalogResponse,
  type PredictiveProfileAnalytics,
  type PredictivePrediction,
  type RFMScoreRow,
  predictiveApi,
} from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { useRemoteResource } from "../../hooks/useRemoteResource";
import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import { remoteFailureFromError } from "../../lib/remote-resource";
import {
  fmtCents,
  fmtPct01,
  parseRFMSegmentCatalog,
  recomputeToastCopy,
  rfmSegmentCounts,
} from "../segments/rfm-helpers";
import {
  ComputedFrom,
  ConfidenceNote,
  EstimateBadge,
  SampleSize,
} from "../common/Provenance";
import { InlineHelp } from "../InlineHelp";
import { toast } from "../Toast";
import {
  type ProfileSort,
  aggregateCLV,
  fmtDate,
  isLowSufficiency,
  predictiveProfileLabel,
  sortProfiles,
} from "./predictive-analytics";

/** We load a capped slice for the aggregate + top-N views. */
const PROFILE_LIMIT = 500;
/** How many rows the top-profiles table shows from the sorted slice. */
const TOP_N = 10;

interface PredictiveAnalyticsBundle {
  profiles: PredictiveProfileAnalytics[] | null;
  catalog: PredictiveCatalogResponse | null;
  warnings: string[];
}

export function PredictiveAnalyticsSection(): ReactElement {
  const canAdmin = useCanAdmin();
  const actionReasonId = useId();
  const mountedRef = useRef(true);
  const refreshFlightRef = useRef<Promise<void> | null>(null);
  const resource = useRemoteResource<PredictiveAnalyticsBundle>(
    async () => {
      const [profilesResponse, catalogResponse] = await Promise.all([
        Promise.resolve().then(() =>
          predictiveApi.profiles({ limit: PROFILE_LIMIT }),
        ),
        Promise.resolve().then(() => predictiveApi.catalog()),
      ]);
      if (profilesResponse.error) {
        return { error: profilesResponse.error };
      }
      const warnings: string[] = [];
      if (catalogResponse.error) {
        warnings.push(
          "The predictive catalog could not be verified; fallback segment labels are shown.",
        );
      }
      return {
        data: {
          profiles: profilesResponse.data.items,
          catalog: catalogResponse.error
            ? null
            : (catalogResponse.data ?? null),
          warnings,
        },
      };
    },
    { identity: "predictive-analytics" },
  );
  const bundle = resource.data;
  const profilePairs = bundle?.profiles ?? null;
  const catalog = bundle?.catalog ?? null;
  const loading = resource.transport === "loading";
  /** Honest population total for the loaded slice, from the last recompute
   *  run (scored_profiles). null until we have a real number. */
  const [scoredTotal, setScoredTotal] = useState<number | null>(null);
  const [sort, setSort] = useState<ProfileSort>("value");
  const recomputeOperation = useSingleFlightOperation({
    ownerId: "predictive-analytics-recompute",
    label: "Predictive analytics recompute",
    detail: "Wait for the predictive recompute to finish before leaving.",
  });

  const refresh = async (): Promise<void> => {
    if (refreshFlightRef.current) return refreshFlightRef.current;
    const request = resource.reload();
    refreshFlightRef.current = request;
    try {
      await request;
    } finally {
      if (refreshFlightRef.current === request) refreshFlightRef.current = null;
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const recompute = async (): Promise<void> => {
    if (!canAdmin) return;
    const request = recomputeOperation.run(async (): Promise<void> => {
      const response = await Promise.resolve().then(() =>
        predictiveApi.recompute(),
      );
      if (response.error) {
        toast.error({
          message: "Recompute failed",
          detail:
            response.error.status === 403
              ? "Admin role required."
              : remoteFailureFromError(response.error).message,
        });
        return;
      }
      if (response.data && mountedRef.current) {
        setScoredTotal(
          typeof response.data.run?.scored_profiles === "number"
            ? response.data.run.scored_profiles
            : null,
        );
        const copy = recomputeToastCopy(response.data);
        if (copy.ok) {
          toast.success({ message: copy.message, detail: copy.detail });
        } else {
          toast.error({ message: copy.message, detail: copy.detail });
        }
      }
      await refresh();
    });
    if (!request) return;
    try {
      await request;
    } catch {
      toast.error({
        message: "Recompute failed",
        detail: remoteFailureFromError({ kind: "network" }).message,
      });
    }
  };

  const loadedPairs = Array.isArray(profilePairs) ? profilePairs : [];
  const loadedProfiles = loadedPairs.map((pair) => pair.prediction);
  const rfmRows: RFMScoreRow[] = loadedPairs.map((pair) => pair.rfm);
  const totals = useMemo(() => aggregateCLV(loadedProfiles), [loadedProfiles]);
  const sortedTop = useMemo(
    () => sortProfiles(loadedProfiles, sort).slice(0, TOP_N),
    [loadedProfiles, sort],
  );

  const segmentCounts = useMemo(
    () =>
      rfmSegmentCounts(rfmRows, parseRFMSegmentCatalog(catalog?.rfm_segments)),
    [rfmRows, catalog],
  );

  // Data-gap: the model hasn't produced anything yet (no profiles AND no
  // RFM rows). Distinct from a load error.
  const hasProfiles = loadedProfiles.length > 0;
  const hasRfm = rfmRows.length > 0;
  const isDataGap = bundle !== null && !loading && !hasProfiles && !hasRfm;
  const recomputing = recomputeOperation.active;

  return (
    <section style={{ marginTop: 12 }}>
      <div className="card pw-chart-card">
        <div className="pw-chart-head">
          <div className="section-title" style={{ marginBottom: 0 }}>
            Predictive analytics
            <InlineHelp text="Heuristic CLV, churn risk, and RFM scores computed from subscriber order history (no LLM). Predicted figures are projections from current data — they carry an Estimate badge. Scores exist only after a recompute has run." />
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            CLV · churn · RFM
          </div>
          <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                if (!loading && !recomputing) void refresh();
              }}
              aria-disabled={loading || recomputing || undefined}
              aria-busy={loading || undefined}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void recompute()}
              aria-disabled={!canAdmin || recomputing || undefined}
              aria-busy={recomputing || undefined}
              aria-describedby={actionReasonId}
            >
              {recomputing ? "Recomputing…" : "Recompute"}
            </button>
          </div>
        </div>
        <div
          id={actionReasonId}
          className="muted"
          role={recomputing ? "status" : undefined}
          style={{ fontSize: 11, marginBottom: 4 }}
        >
          {!canAdmin
            ? "Admin access is required to recompute predictive scores."
            : recomputing
              ? "Recomputing predictive scores and refreshing all three datasets; this may take up to a minute."
              : "Recompute runs synchronously, may take up to a minute, and refreshes profiles, RFM groups, and the model catalog."}
        </div>

        {/* First-party-only benchmark honesty (AN-04). */}
        <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
          Benchmarks reflect this workspace&apos;s own data only. Industry /
          peer-network averages aren&apos;t available — no external average is
          shown or implied.
        </div>

        {resource.failure ? (
          <div className="notice" role="alert">
            <span>
              Couldn&apos;t verify predictive data: {resource.failure.message}
              {resource.stale
                ? " The last verified predictive data remains visible below."
                : ""}
            </span>
            <span className="spacer" style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                if (!loading && !recomputing) void refresh();
              }}
              aria-disabled={loading || recomputing || undefined}
              aria-busy={loading || undefined}
            >
              {loading ? "Retrying…" : "Retry predictive data"}
            </button>
          </div>
        ) : null}
        {bundle?.warnings.length ? (
          <div className="notice" role="status">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {bundle.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {loading && bundle ? (
          <div className="muted" role="status" style={{ marginBottom: 8 }}>
            Refreshing predictive analytics; showing the last verified data.
          </div>
        ) : null}
        {!bundle && loading ? (
          <div className="pw-chart-empty" role="status">
            Loading predictive analytics…
          </div>
        ) : !bundle ? (
          <div className="pw-chart-empty">
            No verified predictive data is available. Retry when the service is
            reachable.
          </div>
        ) : isDataGap ? (
          <div className="pw-chart-empty" style={{ display: "grid", gap: 8 }}>
            <span>
              Predictive scores appear after a recompute runs over subscribers
              with order events. Once order data is ingested,{" "}
              {canAdmin
                ? "run Recompute to score profiles."
                : "an admin can run Recompute to score profiles."}
            </span>
            <div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void recompute()}
                aria-disabled={!canAdmin || recomputing || undefined}
                aria-busy={recomputing || undefined}
                aria-describedby={actionReasonId}
              >
                {recomputing ? "Recomputing…" : "Recompute now"}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 16 }}>
            {/* ---------- 1. CLV summary ---------- */}
            <CLVSummary totals={totals} scoredTotal={scoredTotal} />
            <div className="muted" style={{ fontSize: 11 }}>
              Values above are computed from this loaded slice of up to{" "}
              {PROFILE_LIMIT.toLocaleString()} profiles, not a guaranteed
              workspace total.
              {loadedProfiles.length >= PROFILE_LIMIT
                ? " The response reached the server cap, so additional profiles may exist."
                : ""}
            </div>

            {/* ---------- 2. Top predictive profiles ---------- */}
            <TopProfiles
              rows={sortedTop}
              loaded={loadedProfiles.length}
              sort={sort}
              onSort={setSort}
            />

            {/* ---------- 3. RFM groups report ---------- */}
            <RFMGroups counts={segmentCounts} total={rfmRows.length} />
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------- 1. CLV summary ------------------------------------------ */

function CLVSummary({
  totals,
  scoredTotal,
}: {
  totals: ReturnType<typeof aggregateCLV>;
  scoredTotal: number | null;
}): ReactElement {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>
        Customer lifetime value
      </div>
      <div
        style={{
          display: "flex",
          gap: 24,
          flexWrap: "wrap",
          alignItems: "baseline",
        }}
      >
        {/* Historic CLV = real order history → NOT an estimate. */}
        <CLVStat
          label="Historic CLV"
          value={fmtCents(totals.historicCents ?? 0)}
        />
        {/* Predicted CLV = projection → estimate. */}
        <CLVStat
          label="Predicted CLV"
          value={fmtCents(totals.predictedCents ?? 0)}
          estimate
        />
        {/* Total CLV = historic + predicted → carries the projection. */}
        <CLVStat
          label="Total CLV"
          value={fmtCents(totals.totalCents ?? 0)}
          estimate
        />
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <SampleSize n={totals.count} noun="scored profiles" />
        {/* Only claim a fraction when we have a real population total
         * (the recompute run's scored_profiles); otherwise the slice IS
         * all we honestly know about. */}
        {scoredTotal != null && scoredTotal > totals.count ? (
          <ComputedFrom
            n={totals.count}
            m={scoredTotal}
            unit="scored profiles"
          />
        ) : null}
      </div>
    </div>
  );
}

function CLVStat({
  label,
  value,
  estimate,
}: {
  label: string;
  value: string;
  estimate?: boolean;
}): ReactElement {
  return (
    <div>
      <div
        className="muted"
        style={{
          fontSize: 10,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {label}
        {estimate ? <EstimateBadge /> : null}
      </div>
      <div className="tabular" style={{ fontSize: 18, color: "var(--pw-fg)" }}>
        {value}
      </div>
    </div>
  );
}

/* ---------- 2. Top predictive profiles ------------------------------ */

function TopProfiles({
  rows,
  loaded,
  sort,
  onSort,
}: {
  rows: PredictivePrediction[];
  loaded: number;
  sort: ProfileSort;
  onSort: (s: ProfileSort) => void;
}): ReactElement {
  const safeRows = Array.isArray(rows) ? rows : [];
  const shown = Math.min(safeRows.length, loaded);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          Top predictive profiles
        </span>
        <span className="muted" style={{ fontSize: 11 }}>
          top {shown.toLocaleString()} of {loaded.toLocaleString()} loaded
          profiles, by {sort === "value" ? "predicted value" : "churn risk"}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <div className="chips" role="group" aria-label="Sort profiles">
          <button
            type="button"
            className={`chip${sort === "value" ? " is-active" : ""}`}
            aria-pressed={sort === "value"}
            onClick={() => onSort("value")}
          >
            By predicted value
          </button>
          <button
            type="button"
            className={`chip${sort === "risk" ? " is-active" : ""}`}
            aria-pressed={sort === "risk"}
            onClick={() => onSort("risk")}
          >
            By churn risk
          </button>
        </div>
      </div>

      {safeRows.length === 0 ? (
        <div className="pw-chart-empty">No scored profiles in the slice.</div>
      ) : (
        <div
          role="region"
          aria-label="Top predictive profiles table"
          tabIndex={0}
          style={{ overflowX: "auto" }}
        >
          <table className="link-table" style={{ width: "100%" }}>
            <caption className="visually-hidden">
              Top predictive subscriber profiles
            </caption>
            <thead>
              <tr style={{ fontSize: 10, color: "var(--pw-fg-subtle)" }}>
                <th scope="col" style={{ textAlign: "left" }}>
                  Profile
                </th>
                <th scope="col" style={{ textAlign: "right" }}>
                  Historic CLV
                </th>
                <th scope="col" style={{ textAlign: "right" }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    Predicted CLV <EstimateBadge />
                  </span>
                </th>
                <th scope="col" style={{ textAlign: "right" }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    Total CLV <EstimateBadge />
                  </span>
                </th>
                <th scope="col" style={{ textAlign: "right" }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    Churn risk <EstimateBadge />
                  </span>
                </th>
                <th scope="col" style={{ textAlign: "right" }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    Orders / yr <EstimateBadge />
                  </span>
                </th>
                <th scope="col" style={{ textAlign: "right" }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    Next order <EstimateBadge />
                  </span>
                </th>
                <th scope="col" style={{ textAlign: "right" }}>
                  Confidence
                </th>
              </tr>
            </thead>
            <tbody>
              {safeRows.map((row, i) => {
                const low = isLowSufficiency(
                  row?.data_sufficiency,
                  row?.churn_risk == null ? undefined : row.confidence,
                );
                return (
                  <tr key={`${row?.email ?? "row"}-${i}`}>
                    <td
                      style={{
                        fontSize: 12,
                        maxWidth: 220,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {predictiveProfileLabel(row)}
                    </td>
                    <td className="tabular" style={{ textAlign: "right" }}>
                      {fmtCents(row?.historic_clv_cents ?? 0)}
                    </td>
                    <td className="tabular" style={{ textAlign: "right" }}>
                      {fmtCents(row?.predicted_clv_cents ?? 0)}
                    </td>
                    <td className="tabular" style={{ textAlign: "right" }}>
                      {fmtCents(row?.total_clv_cents ?? 0)}
                    </td>
                    <td className="tabular" style={{ textAlign: "right" }}>
                      {fmtPct01(row?.churn_risk ?? 0)}
                    </td>
                    <td className="tabular" style={{ textAlign: "right" }}>
                      {(row?.predicted_order_count ?? 0).toLocaleString()}
                    </td>
                    <td
                      className="tabular"
                      style={{ textAlign: "right", whiteSpace: "nowrap" }}
                    >
                      {fmtDate(row?.expected_next_order_at)}
                    </td>
                    <td style={{ textAlign: "right", fontSize: 11 }}>
                      {/* Confidence + data_sufficiency are REQUIRED on
                       * every prediction — never hidden. */}
                      <span className="tabular">
                        {fmtPct01(row?.confidence ?? 0)}
                      </span>{" "}
                      <span className="muted">
                        ({row?.data_sufficiency ?? "unknown"})
                      </span>
                      {/* Caution copy only when the server itself reports
                       * a weak sample for this row — never fabricated. */}
                      {low ? (
                        <div>
                          <ConfidenceNote level="low" />
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------- 3. RFM groups report ------------------------------------ */

function RFMGroups({
  counts,
  total,
}: {
  counts: { key: string; label: string; count: number }[];
  total: number;
}): ReactElement {
  const safeCounts = Array.isArray(counts) ? counts : [];
  const withData = safeCounts.filter((c) => c.count > 0);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13 }}>RFM groups</span>
        <InlineHelp text="Loaded profiles grouped by the RFM row nested alongside each prediction. The list is capped at 500, so these counts are a slice, not workspace totals. Group labels come from the server's segment catalog." />
        <span className="muted" style={{ fontSize: 11 }}>
          <SampleSize n={total} noun="loaded scored profiles" />
        </span>
      </div>
      {withData.length === 0 ? (
        <div className="pw-chart-empty">
          No RFM segment data yet — segments populate after a recompute.
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {withData.map((s, i) => (
            <span key={`${s.key || "seg"}-${i}`} className="badge">
              {s.label}{" "}
              <strong className="tabular">
                {(s.count ?? 0).toLocaleString()}
              </strong>
              <span className="muted"> · segment key: {s.key}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
