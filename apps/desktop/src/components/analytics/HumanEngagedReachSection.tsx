/**
 * Human-engaged reach — F12 on the desktop.
 *
 * Every other figure on this page counts opens and clicks, and both count
 * machines: image proxies, prefetchers and security scanners generate them.
 * This is the number we can actually defend as people, and it is the one that
 * gets copied into a board deck — which is why the honesty rules are enforced
 * here rather than left to the reader.
 *
 * The section renders the SERVER's sentence. ReachReport.Headline exists so a
 * client cannot show the floor without its unknown band, and rebuilding the
 * sentence locally is how that band gets dropped.
 *
 * Caveats print ABOVE the figure. A caveat underneath is read after the number
 * has already been believed.
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  getHumanEngagedReach,
  parseReachReport,
  reachCaveats,
  reachHeadline,
  REACH_UNAVAILABLE_MESSAGE,
  type HumanEngagedReach,
} from "../../lib/human-engaged-reach";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; report: HumanEngagedReach }
  // Distinct from "ready with zeros": a failure to measure is not a
  // measurement of nothing, and the copy has to say which one happened.
  | { status: "unavailable"; message: string };

const integer = (value: number) => value.toLocaleString();

export function HumanEngagedReachSection(): ReactElement | null {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getHumanEngagedReach();
      if (cancelled) return;
      // ApiResult is a union: an error member, a queued member with no data,
      // and a success member. Anything that is not a success is "we did not
      // measure", never "we measured zero".
      if (result.error || result.data === undefined) {
        setState({
          status: "unavailable",
          message: result.error?.message || REACH_UNAVAILABLE_MESSAGE,
        });
        return;
      }
      const report = parseReachReport(result.data);
      if (!report) {
        setState({
          status: "unavailable",
          message: REACH_UNAVAILABLE_MESSAGE,
        });
        return;
      }
      setState({ status: "ready", report });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <section className="card pw-chart-card" aria-busy="true">
        <h3 className="section-title">Human-engaged reach</h3>
        <p className="muted">Loading…</p>
      </section>
    );
  }

  if (state.status === "unavailable") {
    return (
      <section className="card pw-chart-card">
        <h3 className="section-title">Human-engaged reach</h3>
        <p role="alert" className="notice">
          {state.message} This is not a reading of zero engagement — no
          measurement was made.
        </p>
      </section>
    );
  }

  const { report } = state;
  const caveats = reachCaveats(report);
  const share =
    report.provider_accepted_recipients > 0
      ? (report.human_engaged_reach_floor /
          report.provider_accepted_recipients) *
        100
      : undefined;
  const machine = Object.entries(report.machine_by_subtype).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    <section className="card pw-chart-card">
      <h3 className="section-title">Human-engaged reach</h3>
      <p className="muted">
        A lower bound from calibrated interaction classification. It does not
        prove a recipient read or understood the message.
      </p>

      {caveats.map((caveat) => (
        <p key={caveat} role="status" className="notice">
          {caveat}
        </p>
      ))}

      <p className="section-title tabular">{reachHeadline(report)}</p>
      {share === undefined ? (
        <p className="muted">
          Nothing was delivered in this window, so there is no share to report.
        </p>
      ) : (
        <p className="muted">
          {share.toFixed(1)}% of {integer(report.provider_accepted_recipients)}{" "}
          accepted recipients, and at most{" "}
          {(
            (report.human_engaged_reach_upper_bound /
              report.provider_accepted_recipients) *
            100
          ).toFixed(1)}
          % once unclassified activity is included.
        </p>
      )}

      <dl className="data-table">
        <div>
          <dt>Human-classified signal</dt>
          <dd className="tabular">
            {integer(report.human_engaged_reach_floor)}
          </dd>
        </div>
        <div>
          <dt>Unclassified</dt>
          <dd className="tabular">{integer(report.unknown_band)}</dd>
        </div>
        <div>
          <dt>Machine only</dt>
          <dd className="tabular">{integer(report.machine_only_recipients)}</dd>
        </div>
        {/* Shown rather than folded away: it is usually the largest group, and
            hiding it makes the other three look like the whole population. */}
        <div>
          <dt>No interaction</dt>
          <dd className="tabular">
            {integer(report.no_interaction_recipients)}
          </dd>
        </div>
      </dl>

      {machine.length > 0 ? (
        <p className="muted">
          Machines seen:{" "}
          {machine
            .map(
              ([subtype, value]) =>
                `${subtype.replace(/_/g, " ")} ${integer(value)}`,
            )
            .join(" · ")}
        </p>
      ) : null}

      <p className="muted">{report.methodology}</p>
      {/* Provenance is part of the deliverable, not debug output: a figure
          quoted externally has to be reproducible later. */}
      <p className="muted tabular">
        classifier {report.classifier_version} · methodology{" "}
        {report.methodology_version} · registry {report.registry_version} ·
        config {report.configuration_hash.slice(0, 12)}
      </p>
    </section>
  );
}
