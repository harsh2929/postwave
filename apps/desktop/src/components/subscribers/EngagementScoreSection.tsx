/**
 * EngagementScoreSection — Subscribers-page card for the engagement
 * score surface (R2: subscriberscore http.go):
 *
 *   - decile distribution strip (GET /engagement-scores/distribution),
 *     one proportional slice per NTILE bucket; clicking a slice seeds
 *     the browse range below.
 *   - "Browse by score" drilldown (GET /engagement-scores/subscribers
 *     ?min=&max=&page=&per_page=) — server-paged table of {email,
 *     score}; rows open the detail slideover via the parent.
 *
 * HONEST-UI: no "Create segment from range" button — the segment
 * compiler has no engagement_score field (it would fall back to a
 * custom-fields text match that matches nothing). See
 * SCORE_SEGMENT_NOTE in engagement-score-helpers.ts for the full
 * rationale; the note is rendered under the table.
 *
 * Hidden entirely when the distribution endpoint 404s (routes not
 * mounted on this deployment) — same convention as
 * LifecycleDistributionCard.
 */

import type { ReactElement } from "react";

import { CategoricalDistributionChart } from "../charts/CategoricalDistributionChart";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";
import { SCORE_SEGMENT_NOTE, browseCaption } from "./engagement-score-helpers";
import {
  type EngagementScoreSectionController,
  useEngagementScoreSectionController,
} from "./useEngagementScoreSectionController";

interface Props {
  /** Opens the subscriber detail slideover for a browse-table row. */
  onOpenSubscriber: (id: string, email: string) => void;
}

/** Low → high tone ramp for the strip slices (deciles ascend left to
 * right). Indexed by slice position fraction. */
function sliceTone(fraction: number): string {
  if (fraction < 1 / 3) return "var(--pw-danger)";
  if (fraction < 2 / 3) return "var(--pw-warning)";
  return "var(--pw-success)";
}

export function EngagementScoreSection({
  onOpenSubscriber,
}: Props): ReactElement | null {
  const controller = useEngagementScoreSectionController();
  if (controller.unavailable) return null;
  return (
    <EngagementScoreSectionPresentation
      controller={controller}
      onOpenSubscriber={onOpenSubscriber}
    />
  );
}

function EngagementScoreSectionPresentation({
  controller,
  onOpenSubscriber,
}: Props & { controller: EngagementScoreSectionController }): ReactElement {
  const {
    browseErr,
    browseLoading,
    browseOpen,
    err,
    items,
    loading,
    maxRaw,
    minRaw,
    page,
    perPage,
    rangeErr,
    total,
    totalPages,
    view,
  } = controller;

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
      aria-label="Engagement scores"
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>Engagement scores</span>
        {view ? (
          <span className="muted tabular" style={{ fontSize: 11 }}>
            {view.total.toLocaleString()} scored subscriber
            {view.total === 1 ? "" : "s"}
          </span>
        ) : null}
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          style={{ fontSize: 11 }}
          onClick={controller.toggleBrowse}
          aria-expanded={browseOpen}
        >
          {browseOpen ? "Hide browse" : "Browse by score"}
        </button>
      </div>

      {loading ? (
        <div role="status" aria-label="Loading engagement score distribution">
          <div className="skel" style={{ height: 22 }} aria-hidden="true" />
        </div>
      ) : err ? (
        <div
          role="alert"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <span className="muted" style={{ fontSize: 12 }}>
            Couldn&apos;t load score distribution: {err}
          </span>
          <button
            type="button"
            className="btn btn-xs"
            style={{ fontSize: 11 }}
            onClick={controller.retryDistribution}
          >
            Retry
          </button>
        </div>
      ) : view && view.slices.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }} role="status">
          No subscribers have been scored yet — the scoring worker sweeps every
          15 minutes once event data exists.
        </div>
      ) : view ? (
        <>
          <CategoricalDistributionChart
            title="Engagement score distribution"
            valueLabel="Scored subscribers"
            height={18}
            segments={view.slices.map((slice, index) => ({
              key: `${slice.range}-${index}`,
              label: `Scores ${slice.range}`,
              value: slice.count,
              share: slice.share,
              color: sliceTone(
                view.slices.length > 1 ? index / (view.slices.length - 1) : 1,
              ),
              onSelect: () => controller.browseSlice(slice.min, slice.max),
            }))}
            provenance={dux025Provenance("engagementScoreDistribution", {
              scope: `Current workspace · ${view.total.toLocaleString()} scored subscribers`,
              note: "Selecting a legend row opens the existing score-range browser.",
            })}
            exportFileName="engagement-score-distribution.csv"
            exportPrivacy="confidential"
          />
          <div
            className="muted"
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 10,
              marginTop: 2,
            }}
          >
            <span>
              Low score · {view.slices[0] ? view.slices[0].range : ""}
            </span>
            <span>{view.slices.at(-1)?.range ?? ""} · high score</span>
          </div>
        </>
      ) : null}

      {browseOpen ? (
        <div style={{ marginTop: 10 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            <label className="muted" style={{ fontSize: 11 }} htmlFor="eng-min">
              Score
            </label>
            <input
              id="eng-min"
              className="input"
              style={{ width: 70, fontSize: 12 }}
              placeholder="min"
              inputMode="numeric"
              value={minRaw}
              onChange={(e) => controller.setMinRaw(e.target.value)}
              aria-label="Minimum score"
            />
            <span className="muted" style={{ fontSize: 11 }}>
              –
            </span>
            <input
              id="eng-max"
              className="input"
              style={{ width: 70, fontSize: 12 }}
              placeholder="max"
              inputMode="numeric"
              value={maxRaw}
              onChange={(e) => controller.setMaxRaw(e.target.value)}
              aria-label="Maximum score"
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void controller.loadBrowsePage(1)}
              disabled={browseLoading}
            >
              {browseLoading ? "Loading…" : "Browse"}
            </button>
            <span className="muted" style={{ fontSize: 10 }}>
              Blank bound = unbounded.
            </span>
          </div>
          {rangeErr ? (
            <div className="field-error" style={{ marginTop: 4 }} role="alert">
              {rangeErr}
            </div>
          ) : null}
          {browseErr ? (
            <div className="field-error" style={{ marginTop: 4 }} role="alert">
              {browseErr}
            </div>
          ) : null}

          {items != null && !browseErr ? (
            <>
              <div
                className="muted"
                style={{ fontSize: 11, margin: "6px 0 4px" }}
              >
                {browseCaption(total, page, perPage, items.length)}
              </div>
              {items.length > 0 ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    maxHeight: 280,
                    overflowY: "auto",
                  }}
                >
                  {items.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => onOpenSubscriber(it.id, it.email)}
                      aria-label={`Open subscriber ${it.email}`}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 60px",
                        gap: 8,
                        alignItems: "center",
                        textAlign: "left",
                        fontSize: 12,
                        padding: "4px 8px",
                      }}
                    >
                      <span
                        style={{
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {it.email}
                      </span>
                      <span className="tabular" style={{ textAlign: "right" }}>
                        {it.score.toLocaleString()}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="pw-chart-empty" role="status">
                  No scored subscribers match this range.
                </div>
              )}
              {totalPages > 1 ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginTop: 6,
                  }}
                >
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={browseLoading || page <= 1}
                    onClick={() => void controller.loadBrowsePage(page - 1)}
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={browseLoading || page >= totalPages}
                    onClick={() => void controller.loadBrowsePage(page + 1)}
                  >
                    Next
                  </button>
                </div>
              ) : null}
              <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>
                {SCORE_SEGMENT_NOTE}
              </div>
            </>
          ) : browseLoading ? (
            <div role="status" aria-label="Loading scored subscribers">
              <div
                className="skel"
                style={{ height: 60, marginTop: 6 }}
                aria-hidden="true"
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
