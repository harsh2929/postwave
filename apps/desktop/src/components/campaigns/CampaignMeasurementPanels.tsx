/**
 * The two campaign measurement surfaces the desktop was missing.
 *
 * HoldoutLiftPanel answers "what did this campaign CAUSE" — every other number
 * on the page only says what happened after it. VanityPathsPanel shows public
 * short-address requests with campaign provenance while preserving that a
 * crawler, prefetcher, forwarded link, or person may have made the request.
 *
 * Both refuse to overstate. The lift panel shows NO number for an underpowered
 * comparison, because liftVerdict's underpowered variant has no field to read
 * one from. The codes panel prints the readership caveat unconditionally,
 * because a request is not evidence a person arrived or read anything.
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  formatSignedPercent,
  getHoldoutLift,
  liftVerdict,
  type HoldoutLift,
} from "../../lib/holdout-lift";
import {
  campaignEvidenceOutcomeLabel,
  listCampaignDirectAttributionEvidence,
  listVanityPaths,
  outcomeVisibilityCaveat,
  readershipCaveat,
  type CampaignDirectAttributionEvidence,
  type VanityPath,
} from "../../lib/vanity-paths";

const rate = (value: number) => `${(value * 100).toFixed(2)}%`;
const integer = (value: number) => value.toLocaleString();

type HoldoutPanelState =
  | { campaignId: string; kind: "loading" }
  | { campaignId: string; kind: "absent" }
  | { campaignId: string; kind: "failed" }
  | { campaignId: string; kind: "ready"; lift: HoldoutLift };

export function HoldoutLiftPanel({
  campaignId,
}: {
  campaignId: string;
}): ReactElement | null {
  const [state, setState] = useState<HoldoutPanelState>({
    campaignId,
    kind: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    setState({ campaignId, kind: "loading" });
    void (async () => {
      const result = await getHoldoutLift(campaignId);
      if (cancelled) return;
      if (result.error) {
        // A campaign with no configured holdout is the normal case. Every
        // other transport/server failure must be visible: hiding it makes a
        // broken measurement surface indistinguishable from no measurement.
        setState({
          campaignId,
          kind: result.error.status === 404 ? "absent" : "failed",
        });
        return;
      }
      if (result.data === undefined) {
        setState({ campaignId, kind: "failed" });
        return;
      }
      setState({ campaignId, kind: "ready", lift: result.data as HoldoutLift });
    })().catch(() => {
      if (!cancelled) setState({ campaignId, kind: "failed" });
    });
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  // Never flash the previous campaign's result while the next request is in
  // flight. The campaign id is part of the state identity for that reason.
  if (
    state.campaignId !== campaignId ||
    state.kind === "loading" ||
    state.kind === "absent"
  ) {
    return null;
  }

  if (state.kind === "failed") {
    return (
      <section className="card pw-chart-card">
        <h3 className="section-title">Incremental lift</h3>
        <p role="alert" className="notice">
          The comparison could not be loaded. This is not a result of zero.
        </p>
      </section>
    );
  }

  const lift = state.lift;
  const verdict = liftVerdict(lift);

  return (
    <section className="card pw-chart-card">
      <h3 className="section-title">Incremental lift</h3>
      <p className="muted">
        {lift.percent}% of the audience was deliberately not sent this campaign.
        The difference between the two groups is what the campaign caused.
      </p>

      {verdict.kind === "pending" ? (
        <p className="muted">{verdict.message}</p>
      ) : verdict.kind === "underpowered" ? (
        // No number, deliberately.
        <p role="status" className="notice">
          Not enough data to measure lift: {verdict.reason} A difference smaller
          than {rate(verdict.minimumDetectableEffect)} cannot be told apart from
          chance at this size, so no figure is shown.
        </p>
      ) : (
        <>
          <p className="section-title tabular">
            {verdict.relativeLift === null
              ? rate(verdict.absoluteLift)
              : formatSignedPercent(verdict.relativeLift)}{" "}
            more conversions than not sending at all
          </p>
          {verdict.interval ? (
            <p className="muted tabular">
              95% confidence interval {rate(verdict.interval.low)} to{" "}
              {rate(verdict.interval.high)} (p = {verdict.pValue.toFixed(3)})
            </p>
          ) : null}
          {verdict.spansZero ? (
            <p role="status" className="notice">
              The confidence interval includes zero, so this campaign may have
              caused no additional conversions at all. Treat the figure as
              directional, not as a result.
            </p>
          ) : null}
          {lift.sent_subs !== undefined && lift.held_out_subs !== undefined ? (
            <dl className="data-table">
              <div>
                <dt>Sent</dt>
                <dd className="tabular">
                  {integer(lift.sent_subs)} · {rate(lift.sent_click_rate ?? 0)}{" "}
                  converted
                </dd>
              </div>
              <div>
                <dt>Held out</dt>
                <dd className="tabular">
                  {integer(lift.held_out_subs)} ·{" "}
                  {rate(lift.held_out_click_rate ?? 0)} converted anyway
                </dd>
              </div>
            </dl>
          ) : null}
        </>
      )}
    </section>
  );
}

export function VanityPathsPanel({
  campaignId,
}: {
  campaignId: string;
}): ReactElement | null {
  const [paths, setPaths] = useState<VanityPath[] | undefined>();
  const [evidenceOffset, setEvidenceOffset] = useState(0);
  const [evidence, setEvidence] = useState<
    | { kind: "loading" }
    | { kind: "failed" }
    | { kind: "ready"; page: CampaignDirectAttributionEvidence }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listVanityPaths(campaignId);
      if (cancelled) return;
      if (result.error || result.data === undefined) return;
      const payload = result.data as { items?: unknown };
      setPaths(
        Array.isArray(payload.items) ? (payload.items as VanityPath[]) : [],
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  useEffect(() => {
    let cancelled = false;
    setEvidence({ kind: "loading" });
    void (async () => {
      const result = await listCampaignDirectAttributionEvidence(
        campaignId,
        evidenceOffset,
      );
      if (cancelled) return;
      if (result.error) {
        setEvidence({ kind: "failed" });
        return;
      }
      setEvidence({ kind: "ready", page: result.data });
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId, evidenceOffset]);

  // Nothing published: stay silent rather than advertise a feature as empty.
  if (
    paths &&
    paths.length === 0 &&
    evidence.kind === "ready" &&
    evidence.page.page_info.total === 0
  ) {
    return null;
  }

  return (
    <section className="card pw-chart-card">
      <h3 className="section-title">Short addresses</h3>
      <p className="muted">
        Addresses the email can print instead of a tracked link, for readers to
        type themselves. Requests may also come from forwarding, crawlers, or
        prefetchers, so they are not human-attention evidence.
      </p>
      {/* Unconditional and before the list: the request count is only honest
          with this sentence beside it. */}
      <p className="notice">{readershipCaveat()}</p>
      <p className="notice">{outcomeVisibilityCaveat()}</p>
      <h4>Audited direct-attribution evidence</h4>
      {evidence.kind === "loading" ? (
        <p className="muted" aria-busy="true">
          Loading attribution receipts…
        </p>
      ) : evidence.kind === "failed" ? (
        <p className="notice danger" role="alert">
          Allocation, visit, redemption, and linked-outcome evidence could not
          be loaded. This is not the same as zero evidence.
        </p>
      ) : (
        <>
          <dl className="metric-grid">
            <div>
              <dt>Code allocations</dt>
              <dd>{integer(evidence.page.summary.code_allocations)}</dd>
            </div>
            <div>
              <dt>Code redemptions</dt>
              <dd>{integer(evidence.page.summary.code_redemptions)}</dd>
            </div>
            <div>
              <dt>No-click observed</dt>
              <dd>{integer(evidence.page.summary.no_click_redemptions)}</dd>
            </div>
            <div>
              <dt>Short-address requests</dt>
              <dd>{integer(evidence.page.summary.vanity_visits)}</dd>
            </div>
            <div>
              <dt>Linked outcomes</dt>
              <dd>
                {integer(
                  evidence.page.summary.code_linked_outcomes +
                    evidence.page.summary.vanity_linked_outcomes,
                )}
              </dd>
            </div>
          </dl>
          {evidence.page.summary.click_evidence_unavailable > 0 ? (
            <p className="notice">
              {integer(evidence.page.summary.click_evidence_unavailable)}{" "}
              historical redemption click observation
              {evidence.page.summary.click_evidence_unavailable === 1
                ? " is"
                : "s are"}{" "}
              unavailable and remain unknown.
            </p>
          ) : null}
          {evidence.page.items.length === 0 ? (
            <p className="muted">
              The authoritative register contains no allocation or short-address
              receipts for this campaign.
            </p>
          ) : (
            <ul aria-label="Direct attribution receipts">
              {evidence.page.items.map((item) => (
                <li key={item.kind + ":" + item.evidence_id}>
                  <strong>
                    {item.kind === "code_allocation"
                      ? "Code allocation"
                      : "Short-address request"}
                  </strong>{" "}
                  <span className="muted">
                    ({item.status}) · receipt {item.evidence_id.slice(0, 8)}
                  </span>
                  {item.kind === "code_allocation" &&
                  item.redemption_id !== null ? (
                    <div className="muted">
                      Click observation:{" "}
                      {item.linked_without_recorded_assignment_click === null
                        ? "unavailable"
                        : item.linked_without_recorded_assignment_click
                          ? "no preceding assignment click observed"
                          : "preceding assignment click observed"}
                    </div>
                  ) : null}
                  {campaignEvidenceOutcomeLabel(
                    item.conversion_id,
                    item.amount_cents,
                    item.currency,
                  ) !== null ? (
                    <div className="muted">
                      {campaignEvidenceOutcomeLabel(
                        item.conversion_id,
                        item.amount_cents,
                        item.currency,
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <div className="button-row">
            <button
              type="button"
              disabled={evidence.page.page_info.offset === 0}
              onClick={() =>
                setEvidenceOffset((current) =>
                  Math.max(0, current - evidence.page.page_info.limit),
                )
              }
            >
              Previous receipts
            </button>
            <span className="muted">
              {evidence.page.page_info.total === 0
                ? "0 receipts"
                : evidence.page.page_info.offset +
                  1 +
                  "–" +
                  Math.min(
                    evidence.page.page_info.offset + evidence.page.items.length,
                    evidence.page.page_info.total,
                  ) +
                  " of " +
                  evidence.page.page_info.total}
            </span>
            <button
              type="button"
              disabled={!evidence.page.page_info.has_more}
              onClick={() =>
                setEvidenceOffset(
                  evidence.page.page_info.offset +
                    evidence.page.page_info.limit,
                )
              }
            >
              Next receipts
            </button>
          </div>
        </>
      )}
      {paths ? (
        <ul>
          {paths.map((path) => (
            <li key={path.id}>
              <code>{path.public_path}</code> → {path.destination_host}
              {path.destination_path}{" "}
              <span className="muted">({path.status})</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
