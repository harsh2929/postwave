/**
 * "Explain this spike" presents an AI narrative beside the deterministic
 * aggregate evidence supplied to the model. The request remains fire-once;
 * closing or retrying invalidates stale responses without claiming transport
 * cancellation that the API does not currently expose.
 */

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The named table overflow region is intentionally keyboard-focusable so non-pointer users can pan it at narrow desktop widths. */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import {
  type AnomalyBriefMetric,
  type AnomalyBriefResponse,
  analyticsNlqApi,
} from "../../lib/api-client";
import { Modal, ModalFooter } from "../Modal";
import {
  DEFAULT_BRIEF_WINDOW_DAYS,
  type BriefErrorCopy,
  briefErrorCopy,
  briefProgressCopy,
  formatBriefDelta,
  formatBriefMetricValue,
  isSupportedBriefCurrency,
} from "./anomaly-brief-helpers";

import "./DashboardEvidenceSurfaces.css";

interface Props {
  open: boolean;
  metric: AnomalyBriefMetric | null;
  windowDays?: number;
  onClose: () => void;
}

interface BriefView {
  windowDays: number;
  summary: string;
  probableCauses: string[];
  suggestedActions: string[];
  aggregates: BriefAggregatesView;
}

interface BriefCampaignView {
  key: string;
  name: string;
  value: number;
}

interface BriefAggregatesView {
  current_total: number;
  previous_total: number;
  top_campaigns: BriefCampaignView[];
  revenue_scope: BriefRevenueScopeView | null;
}

interface BriefRevenueScopeView {
  currency: string | null;
  monetary_conversion_count: number;
  excluded_currency_count: number;
}

const MAX_NARRATIVE_LENGTH = 4_000;
const MAX_LIST_ITEM_LENGTH = 1_000;
const MAX_INSIGHT_ITEMS = 8;
const MAX_CAMPAIGNS = 10;
const MAX_DAILY_ROWS = 366;
const MAX_CAMPAIGN_NAME_LENGTH = 240;

const EVENT_VOLUME_LABELS: Record<
  Exclude<AnomalyBriefMetric, "revenue">,
  string
> = {
  opens: "open-event",
  clicks: "click-event",
  bounces: "bounce-event",
  complaints: "complaint-event",
  unsubscribes: "unsubscribe-event",
};

const CONTROL_OR_BIDI_PATTERN = /[\p{Cc}\p{Cf}]+/gu;
const EMAIL_PATTERN =
  /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/giu;
const PHONE_PATTERN =
  /(^|[^a-z0-9])(?:\+?\d[\d\s().-]{7,}\d)(?=$|[^a-z0-9])/giu;
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const EXPLICIT_PROFILE_IDENTIFIER_PATTERN =
  /\b(?:subscriber|profile)[\s_-]*(?:id|identifier|key)\s*(?::|=|#|\bis\b)?\s*["']?[a-z0-9][a-z0-9._:@/-]{1,319}["']?/giu;
const LABELED_PROFILE_PATTERN =
  /\b(?:subscriber|profile)\s*(?::|#)\s*["']?[a-z0-9][a-z0-9._:@/-]{1,319}["']?/giu;
const PREFIXED_PROFILE_IDENTIFIER_PATTERN =
  /\b(?:subscriber|profile)[_-][a-z0-9][a-z0-9_-]{2,319}\b/giu;
const LINK_PATTERN =
  /\b(?:https?|ftp|file|mailto|data|javascript):(?:\/\/)?[^\s<>"']+/giu;
const BARE_DOMAIN_PATTERN =
  /\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[^\s<>"']*)?/giu;
const NAMED_CREDENTIAL_PATTERN =
  /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key|password|token|secret|authorization|session|cookie)\b\s*[:=]\s*(?:bearer[\s-]+)?[^\s,;]+/giu;
const BEARER_PATTERN = /\bbearer\s+[a-z0-9._~+/-]+/giu;
const TOKEN_PATTERN =
  /\b(?:(?:sk|pk|pat|ghp|gho|ghu|ghs|ghr|xox[baprs])[-_][a-z0-9_-]{8,}|akia[0-9a-z]{12,}|eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})\b/giu;

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeModelText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  // Normalize confusable full-width forms before scanning and inspect beyond
  // the final display bound. Redaction can shorten text, so slicing to the
  // display length first could otherwise pull an unscanned secret into view.
  const scanLength = Math.min(maxLength * 4, maxLength + 12_000);
  return value
    .slice(0, scanLength)
    .normalize("NFKC")
    .replace(/[\t\n\r]+/gu, " ")
    .replace(CONTROL_OR_BIDI_PATTERN, " [control removed] ")
    .replace(LINK_PATTERN, "[link redacted]")
    .replace(EMAIL_PATTERN, "[email redacted]")
    .replace(UUID_PATTERN, "[identifier redacted]")
    .replace(
      EXPLICIT_PROFILE_IDENTIFIER_PATTERN,
      "[profile identifier redacted]",
    )
    .replace(LABELED_PROFILE_PATTERN, "[profile identifier redacted]")
    .replace(
      PREFIXED_PROFILE_IDENTIFIER_PATTERN,
      "[profile identifier redacted]",
    )
    .replace(PHONE_PATTERN, "$1[phone redacted]")
    .replace(NAMED_CREDENTIAL_PATTERN, "$1: [credential redacted]")
    .replace(BEARER_PATTERN, "[credential redacted]")
    .replace(TOKEN_PATTERN, "[credential redacted]")
    .replace(BARE_DOMAIN_PATTERN, "[link redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_INSIGHT_ITEMS)
    .map((item) => safeModelText(item, MAX_LIST_ITEM_LENGTH))
    .filter((item) => item.length > 0);
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

function normalizeAggregates(
  value: unknown,
  expectedMetric: AnomalyBriefMetric,
  expectedWindowDays: number,
): BriefAggregatesView | null {
  if (!value || typeof value !== "object") return null;
  const aggregates = value as AnomalyBriefResponse["aggregates"];
  if (
    aggregates.metric !== expectedMetric ||
    aggregates.window_days !== expectedWindowDays ||
    !nonNegativeInteger(aggregates.current_total) ||
    !nonNegativeInteger(aggregates.previous_total) ||
    !Array.isArray(aggregates.daily) ||
    aggregates.daily.length > MAX_DAILY_ROWS ||
    !Array.isArray(aggregates.top_campaigns)
  ) {
    return null;
  }
  if (
    !aggregates.daily.every((row) =>
      Boolean(row && validDay(row.day) && nonNegativeInteger(row.value)),
    )
  ) {
    return null;
  }
  const campaigns: BriefCampaignView[] = [];
  for (const [index, campaign] of aggregates.top_campaigns
    .slice(0, MAX_CAMPAIGNS)
    .entries()) {
    if (
      !campaign ||
      typeof campaign !== "object" ||
      !nonNegativeInteger(campaign.value)
    ) {
      return null;
    }
    campaigns.push({
      key: `campaign-${index + 1}`,
      name:
        safeModelText(campaign.campaign_name, MAX_CAMPAIGN_NAME_LENGTH) ||
        `Unnamed campaign ${index + 1}`,
      value: campaign.value,
    });
  }
  let revenueScope: BriefRevenueScopeView | null = null;
  if (expectedMetric === "revenue") {
    const scope = aggregates.revenue_scope;
    if (
      !scope ||
      typeof scope !== "object" ||
      !nonNegativeInteger(scope.monetary_conversion_count) ||
      !nonNegativeInteger(scope.excluded_currency_count)
    ) {
      return null;
    }
    if (scope.monetary_conversion_count === 0) {
      if (
        scope.currency !== null ||
        scope.excluded_currency_count !== 0 ||
        aggregates.current_total !== 0 ||
        aggregates.previous_total !== 0 ||
        aggregates.daily.length !== 0 ||
        campaigns.length !== 0
      ) {
        return null;
      }
    } else if (
      !isSupportedBriefCurrency(scope.currency) ||
      scope.excluded_currency_count > scope.monetary_conversion_count - 1
    ) {
      return null;
    }
    revenueScope = {
      currency: scope.currency,
      monetary_conversion_count: scope.monetary_conversion_count,
      excluded_currency_count: scope.excluded_currency_count,
    };
  } else if (aggregates.revenue_scope !== undefined) {
    // A currency scope on a count metric is mismatched evidence. Reject it
    // rather than letting a response for another metric look plausible.
    return null;
  }
  return {
    current_total: aggregates.current_total,
    previous_total: aggregates.previous_total,
    top_campaigns: campaigns,
    revenue_scope: revenueScope,
  };
}

function briefView(
  value: AnomalyBriefResponse | null | undefined,
  expectedMetric: AnomalyBriefMetric,
  expectedWindowDays: number,
): BriefView | null {
  if (!value || typeof value !== "object") return null;
  if (
    value.metric !== expectedMetric ||
    value.window_days !== expectedWindowDays
  ) {
    return null;
  }
  const aggregates = normalizeAggregates(
    value.aggregates,
    expectedMetric,
    expectedWindowDays,
  );
  if (!aggregates) return null;
  return {
    windowDays: expectedWindowDays,
    summary: safeModelText(value.summary, MAX_NARRATIVE_LENGTH),
    probableCauses: stringArray(value.probable_causes),
    suggestedActions: stringArray(value.suggested_actions),
    aggregates,
  };
}

export function AnomalyBriefModal({
  open,
  metric,
  windowDays = DEFAULT_BRIEF_WINDOW_DAYS,
  onClose,
}: Props): ReactElement | null {
  const requestedWindowDays =
    positiveInteger(windowDays) && windowDays <= MAX_DAILY_ROWS
      ? windowDays
      : DEFAULT_BRIEF_WINDOW_DAYS;
  const contentId = useId();
  const [brief, setBrief] = useState<BriefView | null>(null);
  const [error, setError] = useState<BriefErrorCopy | null>(null);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!open || !metric) return;
    const seq = ++seqRef.current;
    setBrief(null);
    setError(null);
    setLoading(true);
    setElapsed(0);
    const tick = window.setInterval(
      () => setElapsed((seconds) => Math.min(seconds + 1, 60)),
      1000,
    );
    void (async () => {
      try {
        const response = await analyticsNlqApi.anomalyBrief({
          metric,
          window_days: requestedWindowDays,
        });
        if (seq !== seqRef.current) return;
        window.clearInterval(tick);
        setLoading(false);
        if (response.error) {
          setError(briefErrorCopy(response.error));
          return;
        }
        const nextBrief = briefView(response.data, metric, requestedWindowDays);
        if (!nextBrief) {
          setError({
            title: "Explanation could not be verified",
            detail:
              "The service returned incomplete or mismatched evidence. Try again before acting on this anomaly.",
            retryable: true,
          });
          return;
        }
        setBrief(nextBrief);
      } catch {
        if (seq !== seqRef.current) return;
        window.clearInterval(tick);
        setLoading(false);
        setError({
          title: "Explanation unavailable",
          detail:
            "The explanation service could not be reached. Check your connection and try again.",
          retryable: true,
        });
      }
    })();
    return () => {
      window.clearInterval(tick);
      if (seq === seqRef.current) seqRef.current += 1;
    };
  }, [open, metric, requestedWindowDays, attempt]);

  if (!open || !metric) return null;

  const summaryId = `${contentId}-summary`;
  const causesId = `${contentId}-causes`;
  const actionsId = `${contentId}-actions`;
  const evidenceId = `${contentId}-evidence`;
  const isRevenue = metric === "revenue";
  const evidenceSubject = isRevenue
    ? "currency-scoped revenue"
    : `${EVENT_VOLUME_LABELS[metric]} volume`;
  const evidenceUnit = isRevenue ? "scoped revenue" : "event count";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Explain ${evidenceSubject}`}
      description={`${isRevenue ? "Currency-scoped value" : "Raw event counts"} · Last ${brief?.windowDays ?? requestedWindowDays} days vs the previous window`}
      size="lg"
    >
      <div className="pw-anomaly-brief" aria-busy={loading || undefined}>
        {loading ? (
          <section className="pw-anomaly-state pw-anomaly-loading">
            <span className="pw-anomaly-loading-mark" aria-hidden="true" />
            <div>
              <strong role="status" aria-live="polite" aria-atomic="true">
                {briefProgressCopy(elapsed)}
              </strong>
              <p>
                <span className="tabular" aria-hidden="true">
                  {elapsed}s elapsed ·{" "}
                </span>
                AI requests can take up to 60 seconds. You can close this dialog
                without applying any change.
              </p>
            </div>
          </section>
        ) : null}

        {error ? (
          <section
            className="notice pw-anomaly-state pw-anomaly-error"
            role="alert"
          >
            <strong>{error.title}</strong>
            <p>{error.detail}</p>
          </section>
        ) : null}

        {brief ? (
          <div className="pw-anomaly-content">
            <section className="pw-anomaly-summary" aria-labelledby={summaryId}>
              <div className="pw-dashboard-evidence-eyebrow">
                AI interpretation
              </div>
              <h3 id={summaryId}>Summary</h3>
              <p>
                {brief.summary ||
                  "No narrative summary was returned. Review the deterministic evidence before taking action."}
              </p>
            </section>

            <div className="pw-anomaly-insight-grid">
              <section
                className="pw-anomaly-insight"
                aria-labelledby={causesId}
              >
                <h3 id={causesId}>Probable causes</h3>
                {brief.probableCauses.length > 0 ? (
                  <ul>
                    {brief.probableCauses.map((cause, index) => (
                      <li key={`${index}-${cause}`}>{cause}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="pw-anomaly-partial">
                    The model did not return probable causes for this window.
                  </p>
                )}
              </section>

              <section
                className="pw-anomaly-insight"
                aria-labelledby={actionsId}
              >
                <h3 id={actionsId}>Suggested actions</h3>
                {brief.suggestedActions.length > 0 ? (
                  <ul>
                    {brief.suggestedActions.map((action, index) => (
                      <li key={`${index}-${action}`}>{action}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="pw-anomaly-partial">
                    The model did not return suggested actions. No change has
                    been applied.
                  </p>
                )}
              </section>
            </div>

            <section
              className="pw-anomaly-evidence"
              aria-labelledby={evidenceId}
            >
              <header className="pw-anomaly-evidence-header">
                <div>
                  <div className="pw-dashboard-evidence-eyebrow">
                    Deterministic evidence
                  </div>
                  <h3 id={evidenceId}>What the numbers say</h3>
                </div>
                <span className="badge pw-anomaly-evidence-badge">
                  Aggregate data
                </span>
              </header>

              {brief.aggregates.revenue_scope ? (
                <p className="pw-anomaly-evidence-empty" role="note">
                  {brief.aggregates.revenue_scope.currency === null
                    ? "No monetary conversions were recorded in either comparison window, so no currency was selected."
                    : `Across both windows, ${brief.aggregates.revenue_scope.monetary_conversion_count.toLocaleString()} monetary ${brief.aggregates.revenue_scope.monetary_conversion_count === 1 ? "conversion was" : "conversions were"} recorded. Revenue totals are scoped to ${brief.aggregates.revenue_scope.currency}${
                        brief.aggregates.revenue_scope.excluded_currency_count >
                        0
                          ? `; ${brief.aggregates.revenue_scope.excluded_currency_count.toLocaleString()} other ${brief.aggregates.revenue_scope.excluded_currency_count === 1 ? "currency was" : "currencies were"} excluded from every total, daily point, and campaign row.`
                          : "."
                      }`}
                </p>
              ) : null}

              <dl
                className="pw-anomaly-comparison"
                aria-label={`${evidenceSubject} window comparison`}
              >
                <div>
                  <dt>
                    Current {brief.windowDays}-day {evidenceUnit}
                  </dt>
                  <dd className="tabular">
                    {formatBriefMetricValue(
                      metric,
                      brief.aggregates.current_total,
                      brief.aggregates.revenue_scope?.currency,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>
                    Previous {brief.windowDays}-day {evidenceUnit}
                  </dt>
                  <dd className="tabular">
                    {formatBriefMetricValue(
                      metric,
                      brief.aggregates.previous_total,
                      brief.aggregates.revenue_scope?.currency,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Change</dt>
                  <dd className="tabular">
                    {formatBriefDelta(
                      brief.aggregates.current_total,
                      brief.aggregates.previous_total,
                      brief.windowDays,
                    )}
                  </dd>
                </div>
              </dl>

              {brief.aggregates.top_campaigns.length > 0 ? (
                // This is the only horizontal overflow owner. It must be
                // keyboard-focusable so non-pointer users can pan a long
                // evidence table at narrow desktop widths.
                <div
                  className="pw-anomaly-evidence-scroll"
                  role="region"
                  aria-label={`Campaign evidence for ${evidenceSubject}`}
                  tabIndex={0}
                >
                  <table className="pw-anomaly-evidence-table">
                    <caption>
                      Campaign totals included in the anomaly explanation
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Campaign</th>
                        <th scope="col">
                          {isRevenue ? "Scoped revenue" : "Event count"}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {brief.aggregates.top_campaigns.map((campaign, index) => (
                        <tr key={`${campaign.key}-${index}`}>
                          <th scope="row">
                            <span className="pw-anomaly-campaign-name">
                              {campaign.name}
                            </span>
                          </th>
                          <td className="tabular">
                            {formatBriefMetricValue(
                              metric,
                              campaign.value,
                              brief.aggregates.revenue_scope?.currency,
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="pw-anomaly-evidence-empty">
                  No per-campaign breakdown was available for this window. The
                  comparison above is the complete deterministic evidence
                  returned by the service.
                </p>
              )}
            </section>

            <aside className="pw-anomaly-disclaimer" role="note">
              AI-generated from aggregate workspace statistics. Model-authored
              text is privacy-filtered, and identity-bearing details are
              redacted before display. Verify the deterministic evidence and
              campaign context before acting.
            </aside>
          </div>
        ) : null}

        <ModalFooter>
          {error?.retryable ? (
            <button
              type="button"
              className="btn"
              onClick={() => setAttempt((current) => current + 1)}
            >
              Try again
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </ModalFooter>
      </div>
    </Modal>
  );
}

/* eslint-enable jsx-a11y/no-noninteractive-tabindex */
