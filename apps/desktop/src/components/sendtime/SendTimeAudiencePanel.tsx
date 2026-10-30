import type { ReactElement } from "react";

import { setSection } from "../../lib/store";
import { Icon } from "../Icon";
import { SendTimeHeatmap } from "./SendTimeHeatmap";
import { SendTimeStatStrip } from "./SendTimeStatStrip";
import { SEND_TIME_AUDIENCE_MINIMUM } from "./model";
import type { useSendTimeAudienceSignals } from "./useSendTimeControllers";

type Controller = ReturnType<typeof useSendTimeAudienceSignals>;

export function SendTimeAudiencePanel({
  controller,
}: {
  controller: Controller;
}): ReactElement {
  const {
    catalog,
    selectedSegment,
    selectedSegmentId,
    setSelectedSegmentId,
    signal,
    loadSegments,
    reloadSignal,
  } = controller;

  return (
    <section
      className="stx-audience"
      aria-labelledby="send-time-audience-title"
    >
      <div className="stx-audience-toolbar">
        <div>
          <div className="stx-kicker">Analyze</div>
          <h2 id="send-time-audience-title" className="stx-section-title">
            Audience attention map
          </h2>
          <p className="stx-section-copy">
            Compare weighted opens, clicks, and replies across the selected
            segment. Recommendations describe past behavior; they do not
            guarantee future engagement.
          </p>
        </div>

        <div className="stx-scope-control">
          <label htmlFor="send-time-segment">Audience scope</label>
          <div className="stx-select-row">
            <select
              id="send-time-segment"
              name="segment_id"
              className="input"
              value={selectedSegmentId}
              disabled={catalog.kind !== "ready"}
              onChange={(event) => setSelectedSegmentId(event.target.value)}
            >
              <option value="">
                {catalog.kind === "loading"
                  ? "Loading segments…"
                  : catalog.kind === "error"
                    ? "Segments unavailable"
                    : catalog.segments.length === 0
                      ? "No saved segments"
                      : "Choose a saved segment…"}
              </option>
              {catalog.kind === "ready"
                ? catalog.segments.map((segment) => (
                    <option key={segment.id} value={segment.id}>
                      {segment.name}
                      {typeof segment.lastCount === "number"
                        ? ` · ${segment.lastCount.toLocaleString()} members`
                        : ""}
                    </option>
                  ))
                : null}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setSection("segments")}
            >
              Manage
              <Icon name="arrow-up-right" size={13} />
            </button>
          </div>
          <span className="stx-field-note">
            A scope is required; Moosewave never substitutes another audience.
          </span>
        </div>
      </div>

      <div className="stx-model-ribbon" role="note">
        <span>
          <Icon name="chart-bars" size={14} />
          180-day measured window
        </span>
        <span>
          <Icon name="users" size={14} />
          Minimum {SEND_TIME_AUDIENCE_MINIMUM} members with signal
        </span>
        <span>
          <Icon name="clock" size={14} />
          UTC source buckets · local projection available
        </span>
      </div>

      {catalog.kind === "error" ? (
        <StateNotice
          tone="danger"
          eyebrow="Segment catalog unavailable"
          title="We couldn’t establish a safe audience scope."
          copy={catalog.message}
          actionLabel="Retry segments"
          onAction={() => void loadSegments()}
        />
      ) : signal.kind === "unscoped" ? (
        <UnscopedState
          hasSegments={catalog.kind !== "ready" || catalog.segments.length > 0}
        />
      ) : signal.kind === "loading" ? (
        <AudienceSkeleton
          segmentName={selectedSegment?.name ?? "selected segment"}
        />
      ) : signal.kind === "insufficient" ? (
        <StateNotice
          tone="neutral"
          eyebrow={selectedSegment?.name ?? "Selected segment"}
          title="The pattern is still taking shape."
          copy={`${signal.message} Moosewave requires at least ${SEND_TIME_AUDIENCE_MINIMUM} members with qualifying engagement before it recommends a window.`}
          actionLabel="Check again"
          onAction={() => void reloadSignal()}
          secondaryLabel="Review segment"
          onSecondary={() => setSection("segments")}
        />
      ) : signal.kind === "error" ? (
        <StateNotice
          tone="danger"
          eyebrow={selectedSegment?.name ?? "Selected segment"}
          title="The audience analysis could not be loaded."
          copy={signal.message}
          actionLabel="Retry analysis"
          onAction={() => void reloadSignal()}
        />
      ) : (
        <div className="stx-audience-results" aria-live="polite">
          <div className="stx-result-context">
            <div>
              <span className="stx-live-mark" aria-hidden="true" />
              Measured recommendation
            </div>
            <span>
              {selectedSegment?.name ?? "Selected segment"}
              {typeof selectedSegment?.lastCount === "number"
                ? ` · ${selectedSegment.lastCount.toLocaleString()} total members`
                : ""}
            </span>
          </div>

          <SendTimeStatStrip
            heatmap={signal.heatmap}
            segmentBest={signal.best}
          />

          {signal.bestWarning ? (
            <div className="stx-inline-warning" role="status">
              The pattern loaded, but model coverage metadata is unavailable:{" "}
              {signal.bestWarning}
            </div>
          ) : null}

          <div className="stx-heatmap-shell">
            <SendTimeHeatmap
              title="Weekly engagement density"
              hint={`${signal.heatmap.subscribers_with_data.toLocaleString()} members with signal · trailing 180 days`}
              grid={signal.heatmap.grid}
              primary={{
                dow: signal.heatmap.best_dow,
                hour: signal.heatmap.best_hour,
              }}
              {...((signal.heatmap.has_secondary ??
                signal.heatmap.has_secondary_window) &&
              signal.heatmap.secondary_dow != null &&
              signal.heatmap.secondary_hour != null
                ? {
                    secondary: {
                      dow: signal.heatmap.secondary_dow,
                      hour: signal.heatmap.secondary_hour,
                    },
                  }
                : {})}
              provenance={{
                source: "Moosewave segment engagement model",
                asOf: signal.heatmap.computed_at ?? null,
                scope: `${selectedSegment?.name ?? "Selected segment"} · trailing 180 days · weighted positive engagement`,
                note: `${signal.heatmap.subscribers_with_data.toLocaleString()} members contributed opens, clicks, or replies. Raw buckets are UTC; local display uses this device's current UTC offset.`,
              }}
              exportFileName={`send-time-${safeFileStem(selectedSegment?.name ?? "segment")}.csv`}
              exportPrivacy="confidential"
            />
          </div>
        </div>
      )}
    </section>
  );
}

function UnscopedState({
  hasSegments,
}: {
  hasSegments: boolean;
}): ReactElement {
  return (
    <div className="stx-unscoped">
      <div className="stx-attention-orbit" aria-hidden="true">
        <span className="stx-orbit-ring is-one" />
        <span className="stx-orbit-ring is-two" />
        <span className="stx-orbit-core">
          <Icon name="clock" size={22} />
        </span>
        <span className="stx-orbit-point is-a" />
        <span className="stx-orbit-point is-b" />
        <span className="stx-orbit-point is-c" />
      </div>
      <div>
        <div className="stx-kicker">
          {hasSegments ? "Waiting for a scope" : "Build an audience first"}
        </div>
        <h3>
          {hasSegments
            ? "Choose the audience you want to understand."
            : "There are no saved segments to analyze yet."}
        </h3>
        <p>
          {hasSegments
            ? "The map stays intentionally blank until you select a saved segment, so no placeholder can be mistaken for measured behavior."
            : "Create a segment from subscriber attributes or engagement, then return here to inspect its strongest weekly windows."}
        </p>
        {!hasSegments ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setSection("segments")}
          >
            Create a segment
            <Icon name="arrow-right" size={14} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function AudienceSkeleton({
  segmentName,
}: {
  segmentName: string;
}): ReactElement {
  return (
    <div
      className="stx-audience-loading"
      role="status"
      aria-label={`Analyzing ${segmentName}`}
    >
      <div className="stx-skeleton-copy">
        <span className="skel" />
        <span className="skel" />
      </div>
      <div className="stx-skeleton-grid" aria-hidden="true">
        {Array.from({ length: 28 }, (_, index) => (
          <span key={index} className="skel" />
        ))}
      </div>
      <span className="visually-hidden">
        Loading engagement pattern for {segmentName}.
      </span>
    </div>
  );
}

function StateNotice({
  tone,
  eyebrow,
  title,
  copy,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
}: {
  tone: "neutral" | "danger";
  eyebrow: string;
  title: string;
  copy: string;
  actionLabel: string;
  onAction: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}): ReactElement {
  return (
    <div
      className={`stx-state-notice${tone === "danger" ? " is-danger" : ""}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      <span className="stx-state-icon" aria-hidden="true">
        <Icon
          name={tone === "danger" ? "alert-triangle" : "chart-bars"}
          size={19}
        />
      </span>
      <div>
        <div className="stx-kicker">{eyebrow}</div>
        <h3>{title}</h3>
        <p>{copy}</p>
        <div className="stx-state-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onAction}
          >
            {actionLabel}
          </button>
          {secondaryLabel && onSecondary ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onSecondary}
            >
              {secondaryLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function safeFileStem(value: string): string {
  const stem = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "segment";
}
