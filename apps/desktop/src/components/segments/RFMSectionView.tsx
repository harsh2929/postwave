import { type FormEvent, type ReactElement } from "react";

import { Heatmap } from "../charts/Heatmap";
import { ConfidenceNote, EstimateBadge } from "../common/Provenance";
import { SectionHeader } from "../SectionHeader";
import { fmtCents, fmtPct01, profilesCaption } from "./rfm-helpers";
import {
  PROFILE_LIMITS,
  type RFMSectionController,
} from "./useRFMSectionController";

interface RFMViewProps {
  canAdmin: boolean;
  controller: RFMSectionController;
}

export function RFMSectionView({
  canAdmin,
  controller,
}: RFMViewProps): ReactElement {
  return (
    <section
      style={{ marginTop: 28 }}
      aria-busy={
        controller.loading ||
        controller.profilesLoading ||
        controller.lookingUp ||
        controller.recomputing
      }
    >
      <RFMHeader canAdmin={canAdmin} controller={controller} />
      {controller.error ? <OverviewError controller={controller} /> : null}
      {controller.loading ? (
        <OverviewSkeleton />
      ) : (
        <OverviewGrid canAdmin={canAdmin} controller={controller} />
      )}
      <PredictiveProfilesCard controller={controller} />
    </section>
  );
}

function RFMHeader({ canAdmin, controller }: RFMViewProps): ReactElement {
  const recomputeUnavailableReason = !canAdmin
    ? "Admin role required to recompute predictive scores."
    : controller.recomputing
      ? "A predictive-score recompute is already in progress."
      : null;
  return (
    <SectionHeader
      title="RFM & predictive"
      description="Recency–frequency–monetary scores and heuristic CLV/churn predictions computed from order history."
      helpText="Scores come from the server's heuristic model (no LLM). They only exist after a recompute has run over subscribers with order events."
      actions={
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {recomputeUnavailableReason ? (
            <span
              id="rfm-recompute-unavailable"
              className="muted"
              style={{ fontSize: 11 }}
            >
              {recomputeUnavailableReason}
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            onClick={controller.refresh}
            disabled={controller.loading}
          >
            {controller.loading ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              if (recomputeUnavailableReason) return;
              void controller.recompute();
            }}
            aria-disabled={recomputeUnavailableReason ? true : undefined}
            aria-describedby={
              recomputeUnavailableReason
                ? "rfm-recompute-unavailable"
                : undefined
            }
          >
            {controller.recomputing ? "Recomputing…" : "Recompute"}
          </button>
        </div>
      }
    />
  );
}

function OverviewError({ controller }: Pick<RFMViewProps, "controller">) {
  return (
    <div className="notice" role="alert">
      <span>Couldn&apos;t load predictive data: {controller.error}</span>
      <button
        type="button"
        className="btn btn-sm"
        onClick={controller.refresh}
        style={{ marginLeft: "auto" }}
        disabled={controller.loading}
      >
        Retry
      </button>
    </div>
  );
}

function OverviewSkeleton(): ReactElement {
  return (
    <div style={{ padding: 12 }} role="status" aria-label="Loading RFM data">
      {[0, 1, 2].map((index) => (
        <div key={index} className="skel-row" />
      ))}
    </div>
  );
}

function OverviewGrid({ canAdmin, controller }: RFMViewProps): ReactElement {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)",
        gap: 12,
        alignItems: "start",
      }}
    >
      <RFMGridCard canAdmin={canAdmin} controller={controller} />
      <div style={{ display: "grid", gap: 12 }}>
        <PredictionModelsCard controller={controller} />
        <ProfileLookupCard controller={controller} />
      </div>
    </div>
  );
}

function RFMGridCard({ canAdmin, controller }: RFMViewProps): ReactElement {
  const { grid, profileSegment, segmentCounts } = controller;
  return (
    <div className="card" style={{ display: "grid", gap: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>
        RFM grid
        <span
          className="muted"
          style={{ fontWeight: 400, marginLeft: 8, fontSize: 11 }}
        >
          subscriber counts by recency × frequency score (monetary dimension not
          shown)
        </span>
      </div>
      {grid && grid.counted > 0 ? (
        <>
          <Heatmap
            rows={grid.rows}
            columns={grid.columns}
            metricLabel="Recency / Frequency"
            valueLabel="Subscribers"
            formatCell={(value) => value.toLocaleString()}
            provenance={{
              source: "Moosewave predictive RFM-segment API",
              asOf: null,
              scope: "Current workspace · loaded RFM score rows",
              note: `${grid.counted.toLocaleString()} scored rows represented; monetary dimension is not shown${grid.skipped > 0 ? `; ${grid.skipped.toLocaleString()} out-of-range rows excluded` : ""}.`,
            }}
            exportFileName="rfm-recency-frequency-grid.csv"
            exportPrivacy="confidential"
          />
          {grid.skipped > 0 ? (
            <div className="muted" style={{ fontSize: 11 }}>
              {grid.skipped.toLocaleString()} row
              {grid.skipped === 1 ? "" : "s"} had out-of-range scores and
              aren&apos;t shown.
            </div>
          ) : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {segmentCounts.map((segment) => (
              <button
                key={segment.key}
                type="button"
                className="badge"
                aria-pressed={profileSegment === segment.key}
                aria-label={
                  profileSegment === segment.key
                    ? `Showing profiles in segment_key ${segment.key} — click to clear the filter`
                    : `Filter the profiles table below to segment_key ${segment.key}`
                }
                onClick={() =>
                  controller.setProfileSegment(
                    profileSegment === segment.key ? "" : segment.key,
                  )
                }
                style={{
                  cursor: "pointer",
                  outline:
                    profileSegment === segment.key
                      ? "1px solid var(--pw-fg)"
                      : undefined,
                }}
              >
                {segment.label}{" "}
                <strong className="tabular">
                  {segment.count.toLocaleString()}
                </strong>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="pw-chart-empty">
          No RFM scores yet. Scores are computed from subscriber order events —{" "}
          {canAdmin
            ? "run Recompute after order data has been ingested."
            : "an admin can run Recompute after order data has been ingested."}
        </div>
      )}
    </div>
  );
}

function PredictionModelsCard({
  controller,
}: Pick<RFMViewProps, "controller">): ReactElement {
  const models = controller.catalog?.models ?? [];
  return (
    <div className="card" style={{ display: "grid", gap: 8 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>Prediction models</div>
      {models.length > 0 ? (
        <div style={{ display: "grid", gap: 4 }}>
          {models.map((model) => (
            <div
              key={model.key}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto auto",
                gap: 8,
                alignItems: "center",
                padding: "5px 8px",
                background: "var(--pw-bg-elev-2)",
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              <span title={model.key}>{model.label}</span>
              <span className="muted tabular" style={{ fontSize: 10 }}>
                {model.version}
              </span>
              <span
                className={
                  model.runtime_status === "available"
                    ? "badge success"
                    : "badge"
                }
              >
                {model.runtime_status}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          Model catalog unavailable.
        </div>
      )}
    </div>
  );
}

function ProfileLookupCard({
  controller,
}: Pick<RFMViewProps, "controller">): ReactElement {
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void controller.lookup();
  };
  return (
    <div className="card" style={{ display: "grid", gap: 8 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>Profile lookup</div>
      <form onSubmit={submit} style={{ display: "flex", gap: 6 }}>
        <input
          type="email"
          className="input"
          style={{ flex: 1 }}
          placeholder="subscriber@example.com"
          aria-label="Subscriber email for predictive profile lookup"
          value={controller.email}
          onChange={(event) => controller.updateEmail(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          className="btn btn-sm"
          disabled={controller.lookingUp}
        >
          {controller.lookingUp ? "Looking up…" : "Look up"}
        </button>
      </form>
      {controller.profileError ? (
        <div
          className="muted"
          style={{ fontSize: 12 }}
          role="status"
          aria-live="polite"
        >
          {controller.profileError}
        </div>
      ) : null}
      {controller.profile ? (
        <ProfileDetails profile={controller.profile} />
      ) : null}
    </div>
  );
}

function ProfileDetails({
  profile,
}: {
  profile: NonNullable<RFMSectionController["profile"]>;
}): ReactElement {
  return (
    <div style={{ display: "grid", gap: 4, fontSize: 12 }} aria-live="polite">
      <ProfileRow
        label="Predicted CLV"
        value={fmtCents(profile.prediction.predicted_clv_cents)}
        estimate
      />
      <ProfileRow
        label="Historic CLV"
        value={fmtCents(profile.prediction.historic_clv_cents)}
      />
      <ProfileRow
        label="Churn risk"
        value={fmtPct01(profile.prediction.churn_risk)}
        estimate
      />
      <ProfileRow
        label="Predicted orders / yr"
        value={String(profile.prediction.predicted_order_count)}
        estimate
      />
      <ProfileRow
        label="RFM"
        value={`${profile.rfm.rfm_score} · ${profile.rfm.segment_key}`}
      />
      <ProfileRow
        label="Confidence"
        value={`${fmtPct01(profile.prediction.confidence)} (${profile.prediction.data_sufficiency})`}
      />
      {isLowSufficiency(
        profile.prediction.data_sufficiency,
        profile.prediction.confidence,
      ) ? (
        <ConfidenceNote level="low" />
      ) : null}
    </div>
  );
}

function PredictiveProfilesCard({
  controller,
}: Pick<RFMViewProps, "controller">): ReactElement {
  const selectedSegmentLabel = controller.profileSegment
    ? (controller.segmentCounts.find(
        (segment) => segment.key === controller.profileSegment,
      )?.label ?? controller.profileSegment)
    : null;
  return (
    <div className="card" style={{ display: "grid", gap: 8, marginTop: 12 }}>
      <ProfilesToolbar controller={controller} />
      {controller.profilesError ? (
        <div className="notice" role="alert" style={{ fontSize: 12 }}>
          <span>Couldn&apos;t load profiles: {controller.profilesError}</span>
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: "auto" }}
            onClick={controller.retryProfiles}
            disabled={controller.profilesLoading}
          >
            Retry
          </button>
        </div>
      ) : controller.profilesLoading ? (
        <div
          className="skel"
          style={{ height: 60 }}
          role="status"
          aria-label="Loading predictive profiles"
        />
      ) : controller.profileRows && controller.profileRows.length > 0 ? (
        <>
          <div style={{ overflowX: "auto" }}>
            <table
              className="link-table"
              style={{ width: "100%" }}
              aria-label="Predictive profiles"
            >
              <ProfilesTableHead />
              <tbody>
                {controller.profileRows.map((row) => (
                  <tr key={`${row.subscriber_id ?? "email"}:${row.email}`}>
                    <td
                      style={{
                        fontSize: 12,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: 240,
                      }}
                      title={row.email}
                    >
                      {row.email}
                    </td>
                    <td className="tabular" style={{ textAlign: "right" }}>
                      {fmtCents(row.predicted_clv_cents)}
                    </td>
                    <td className="tabular" style={{ textAlign: "right" }}>
                      {fmtCents(row.historic_clv_cents)}
                    </td>
                    <td className="tabular" style={{ textAlign: "right" }}>
                      {fmtPct01(row.churn_risk)}
                    </td>
                    <td className="tabular" style={{ textAlign: "right" }}>
                      {row.predicted_order_count}
                    </td>
                    <td
                      className="tabular"
                      style={{ textAlign: "right" }}
                      title={`data sufficiency: ${row.data_sufficiency}`}
                    >
                      {fmtPct01(row.confidence)} ({row.data_sufficiency})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            {profilesCaption(
              controller.profileRows.length,
              controller.profileLimit,
              selectedSegmentLabel,
            )}
          </div>
        </>
      ) : (
        <div className="pw-chart-empty">
          {profilesCaption(0, controller.profileLimit, selectedSegmentLabel)}
        </div>
      )}
    </div>
  );
}

function ProfilesToolbar({
  controller,
}: Pick<RFMViewProps, "controller">): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <span
        style={{
          fontWeight: 600,
          fontSize: 13,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        Predictive profiles
        <EstimateBadge />
      </span>
      <span className="muted" style={{ fontSize: 11 }}>
        scored subscribers, filterable by RFM segment
      </span>
      <span className="spacer" style={{ flex: 1 }} />
      <label
        htmlFor="rfm-prof-segment"
        className="muted"
        style={{ fontSize: 11 }}
      >
        Segment
      </label>
      <select
        id="rfm-prof-segment"
        className="input"
        style={{ width: "auto", minWidth: 150 }}
        value={controller.profileSegment}
        onChange={(event) => controller.setProfileSegment(event.target.value)}
      >
        <option value="">All segments</option>
        {controller.segmentCounts.map((segment) => (
          <option key={segment.key} value={segment.key}>
            {segment.label}
          </option>
        ))}
      </select>
      <label
        htmlFor="rfm-prof-limit"
        className="muted"
        style={{ fontSize: 11 }}
      >
        Limit
      </label>
      <select
        id="rfm-prof-limit"
        className="input"
        style={{ width: "auto" }}
        value={controller.profileLimit}
        onChange={(event) =>
          controller.setProfileLimit(Number(event.target.value))
        }
      >
        {PROFILE_LIMITS.map((limit) => (
          <option key={limit} value={limit}>
            {limit}
          </option>
        ))}
      </select>
    </div>
  );
}

function ProfilesTableHead(): ReactElement {
  return (
    <thead>
      <tr style={{ fontSize: 11, color: "var(--pw-fg-subtle)" }}>
        <th style={{ textAlign: "left" }}>Email</th>
        <th style={{ textAlign: "right" }}>Predicted CLV</th>
        <th style={{ textAlign: "right" }}>Historic CLV</th>
        <th style={{ textAlign: "right" }}>Churn risk</th>
        <th style={{ textAlign: "right" }}>Orders / yr</th>
        <th style={{ textAlign: "right" }}>Confidence</th>
      </tr>
    </thead>
  );
}

function isLowSufficiency(
  dataSufficiency: string | undefined,
  confidence: number | undefined,
): boolean {
  const sufficiency = (dataSufficiency ?? "").toLowerCase();
  if (sufficiency.includes("low") || sufficiency.includes("insufficient")) {
    return true;
  }
  return typeof confidence === "number" && confidence > 0 && confidence < 0.4;
}

function ProfileRow({
  label,
  value,
  estimate,
}: {
  label: string;
  value: string;
  estimate?: boolean;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        padding: "4px 8px",
        background: "var(--pw-bg-elev-2)",
        borderRadius: 4,
      }}
    >
      <span
        className="muted"
        style={{ display: "flex", alignItems: "center", gap: 6 }}
      >
        {label}
        {estimate ? <EstimateBadge /> : null}
      </span>
      <span className="tabular">{value}</span>
    </div>
  );
}
