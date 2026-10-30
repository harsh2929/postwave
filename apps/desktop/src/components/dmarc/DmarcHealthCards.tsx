import type { ReactElement } from "react";

import type { DmarcInsights } from "../../lib/api-client";

import { DmarcAlignmentSparkline } from "./DmarcAlignmentSparkline";

interface Props {
  insights: DmarcInsights;
  /** A retained, contract-valid snapshot remains visible while a refresh runs. */
  loading?: boolean;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatCountLabel(
  value: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${formatCount(value)} ${value === 1 ? singular : plural}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value >= 0.995 ? 2 : 1)}%`;
}

function alignmentTone(value: number): "positive" | "caution" | "negative" {
  if (value >= 0.995) return "positive";
  if (value >= 0.9) return "caution";
  return "negative";
}

export function DmarcHealthCards({ insights, loading }: Props): ReactElement {
  const alignment = insights.alignment;
  const disposition = insights.disposition;
  const hasMessages = insights.totalMessages > 0;
  const aligned =
    alignment.bothPass + alignment.dkimOnlyPass + alignment.spfOnlyPass;
  const noActionWidth = hasMessages
    ? (disposition.none / insights.totalMessages) * 100
    : 0;
  const quarantineWidth = hasMessages
    ? (disposition.quarantine / insights.totalMessages) * 100
    : 0;
  const rejectWidth = hasMessages
    ? (disposition.reject / insights.totalMessages) * 100
    : 0;
  const unknownWidth = hasMessages
    ? (disposition.unknown / insights.totalMessages) * 100
    : 0;

  return (
    <section
      className={`dmarc-health-cards${loading ? " is-refreshing" : ""}`}
      aria-label="Validated DMARC aggregate summary"
    >
      {loading ? (
        <span className="dmarc-health-refresh" role="status">
          Refreshing insights; retained metrics remain readable until the new
          response validates.
        </span>
      ) : null}
      <article className="dmarc-card dmarc-card--alignment">
        <div className="dmarc-card__header">
          <div>
            <span className="dmarc-card__eyebrow">
              Authentication alignment
            </span>
            <h2>
              {hasMessages
                ? formatPercent(alignment.alignedPct)
                : "Not observed"}
            </h2>
          </div>
          {hasMessages ? (
            <span
              className="dmarc-status-orb"
              data-tone={alignmentTone(alignment.alignedPct)}
            />
          ) : null}
        </div>
        <p>
          {hasMessages
            ? `${formatCount(aligned)} of ${formatCount(
                insights.totalMessages,
              )} ${insights.totalMessages === 1 ? "message" : "messages"} passed aligned DKIM, aligned SPF, or both.`
            : "No message denominator exists for this validated scope, so no percentage is shown."}
        </p>
        {hasMessages ? (
          <dl className="dmarc-mini-metrics">
            <div>
              <dt>SPF + DKIM</dt>
              <dd>{formatCount(alignment.bothPass)}</dd>
            </div>
            <div>
              <dt>DKIM only</dt>
              <dd>{formatCount(alignment.dkimOnlyPass)}</dd>
            </div>
            <div>
              <dt>SPF only</dt>
              <dd>{formatCount(alignment.spfOnlyPass)}</dd>
            </div>
            <div data-tone={alignment.neitherPass > 0 ? "negative" : undefined}>
              <dt>Neither</dt>
              <dd>{formatCount(alignment.neitherPass)}</dd>
            </div>
          </dl>
        ) : null}
        {insights.series && insights.series.length > 1 ? (
          <div className="dmarc-card__chart">
            <DmarcAlignmentSparkline
              series={insights.series}
              domain={insights.domain}
              generatedAt={insights.generatedAt}
              periodDays={insights.periodDays}
              windowStart={insights.windowStart}
              windowEnd={insights.windowEnd}
              width={300}
              height={44}
            />
            <small>
              Calendar-spaced · unobserved days remain visible as gaps
            </small>
          </div>
        ) : null}
      </article>

      <article className="dmarc-card">
        <span className="dmarc-card__eyebrow">Reported policy actions</span>
        <h2>{hasMessages ? formatCount(disposition.none) : "Not observed"}</h2>
        <p>
          {hasMessages
            ? `${disposition.none === 1 ? "message was" : "messages were"} explicitly reported with disposition=none. This is not an inbox-delivery claim.`
            : "No report policy-action denominator exists for this scope."}
        </p>
        {hasMessages ? (
          <>
            <div className="dmarc-disposition-bar" aria-hidden="true">
              <span
                className="is-none"
                style={{ width: `${noActionWidth}%` }}
              />
              <span
                className="is-quarantine"
                style={{ width: `${quarantineWidth}%` }}
              />
              <span
                className="is-reject"
                style={{ width: `${rejectWidth}%` }}
              />
              <span
                className="is-unknown"
                style={{ width: `${unknownWidth}%` }}
              />
            </div>
            <dl className="dmarc-disposition-legend">
              <div>
                <dt>
                  <span className="is-quarantine" />
                  Quarantine
                </dt>
                <dd>{formatCount(disposition.quarantine)}</dd>
              </div>
              <div>
                <dt>
                  <span className="is-reject" />
                  Reject
                </dt>
                <dd>{formatCount(disposition.reject)}</dd>
              </div>
              <div data-tone={disposition.unknown > 0 ? "caution" : undefined}>
                <dt>
                  <span className="is-unknown" />
                  Unknown
                </dt>
                <dd>{formatCount(disposition.unknown)}</dd>
              </div>
            </dl>
          </>
        ) : null}
      </article>

      <article className="dmarc-card">
        <span className="dmarc-card__eyebrow">Evidence coverage</span>
        <h2>{formatCountLabel(insights.reportCount, "report")}</h2>
        <p>
          {formatCountLabel(insights.totalMessages, "message")} across{" "}
          {formatCountLabel(insights.reportingDays, "reporting day")} in the
          selected {formatCount(insights.periodDays)}-day window.
        </p>
        <dl className="dmarc-coverage-grid">
          <div>
            <dt>Observed sources</dt>
            <dd>{formatCount(insights.sourceCount)}</dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd title={insights.domain || "All available domains"}>
              {insights.domain || "All domains"}
            </dd>
          </div>
        </dl>
        <span className="dmarc-card__footnote">
          Counts are aggregate-report observations, not unique recipients.
        </span>
      </article>
    </section>
  );
}
