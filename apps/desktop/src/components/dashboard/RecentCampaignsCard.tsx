/**
 * RecentCampaignsCard — last 5 sent campaigns with click-to-detail.
 * Extracted from pages/Dashboard.tsx without behavior change so the
 * page composition stays readable.
 */

import { type ReactElement, useId } from "react";

import { type Campaign } from "../../lib/api-client";
import { navigateDesktopSectionResource } from "../../lib/desktop-router";
import { fmtDayMonth } from "../../lib/format-date";
import { setSection } from "../../lib/store";
import { setPendingCampaignDraft } from "../../lib/template-handoff";
import { Icon } from "../Icon";

interface Props {
  campaigns: Campaign[] | null;
  loading: boolean;
  error?: boolean;
  stale?: boolean;
  onRetry?: () => void | Promise<void>;
}

function fmtPct(p: number | undefined | null): string {
  if (p == null || !Number.isFinite(p) || p < 0 || p > 1) return "—";
  return `${(p * 100).toFixed(1)}%`;
}

export function RecentCampaignsCard({
  campaigns,
  loading,
  error = false,
  stale = false,
  onRetry,
}: Props): ReactElement {
  const rowIdPrefix = useId();
  const initialFailure = error && campaigns === null;
  const initialLoading = loading && campaigns === null && !initialFailure;
  const refreshing = loading && campaigns !== null;

  return (
    <section
      className="card pw-dash-secondary-card pw-dash-secondary-campaigns"
      data-tour="dashboard-recent-campaigns"
      aria-labelledby="dashboard-recent-campaigns-title"
      aria-busy={loading}
    >
      <header className="pw-dash-secondary-header">
        <div className="pw-dash-secondary-heading-group">
          <span className="pw-dash-secondary-eyebrow">Latest sends</span>
          <h3 id="dashboard-recent-campaigns-title">Recent campaigns</h3>
        </div>
        {refreshing ? (
          <span className="pw-dash-secondary-refresh" role="status">
            Refreshing
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost pw-dash-secondary-link-action"
          onClick={() => setSection("campaigns")}
        >
          See all
          <Icon name="arrow-right" size={13} />
        </button>
      </header>
      {initialFailure ? (
        <CampaignLoadNotice loading={loading} onRetry={onRetry} stale={false} />
      ) : initialLoading ? (
        <div
          className="pw-dash-secondary-skeleton-stack"
          role="status"
          aria-live="polite"
          aria-label="Loading recent campaigns"
        >
          <span className="sr-only">Loading recent campaigns</span>
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className="skel pw-dash-secondary-skeleton-line"
              aria-hidden="true"
            />
          ))}
        </div>
      ) : (
        <>
          {stale ? (
            <CampaignLoadNotice loading={loading} onRetry={onRetry} stale />
          ) : null}
          {campaigns && campaigns.length > 0 ? (
            <div className="pw-dash-secondary-campaign-table">
              <div
                className="pw-dash-secondary-campaign-columns"
                aria-hidden="true"
              >
                <span>Campaign</span>
                <span>Sent</span>
                <span>Opens</span>
                <span>Clicks</span>
              </div>
              <ul className="pw-dash-secondary-list pw-dash-secondary-campaign-list">
                {campaigns.map((c, i) => {
                  const name = campaignName(c);
                  const sentAt = campaignDate(c);
                  const campaignId = safeCampaignId(c.id);
                  const nameId = `${rowIdPrefix}-campaign-${i}-name`;
                  const actionId = `${rowIdPrefix}-campaign-${i}-action`;
                  const metricsId = `${rowIdPrefix}-campaign-${i}-metrics`;
                  return (
                    <li key={`${String(c.id ?? "campaign")}:${i}`}>
                      <button
                        type="button"
                        className="pw-dash-secondary-campaign-row"
                        aria-labelledby={`${actionId} ${nameId}`}
                        aria-describedby={metricsId}
                        onClick={() => {
                          if (campaignId !== null) {
                            navigateDesktopSectionResource(
                              "campaigns",
                              campaignId,
                            );
                            return;
                          }
                          setSection("campaigns");
                        }}
                      >
                        <span id={actionId} className="sr-only">
                          Open campaign
                        </span>
                        <span className="pw-dash-secondary-campaign-name">
                          <strong id={nameId}>{name}</strong>
                          <span>{campaignStatus(c)}</span>
                        </span>
                        <span className="tabular" data-label="Sent">
                          {fmtDayMonth(sentAt)}
                        </span>
                        <span className="tabular" data-label="Opens">
                          {fmtPct(c.open_rate)}
                        </span>
                        <span className="tabular" data-label="Clicks">
                          {fmtPct(c.click_rate)}
                        </span>
                        <span id={metricsId} className="sr-only">
                          Sent {fmtDayMonth(sentAt)}. Open rate{" "}
                          {fmtPct(c.open_rate)}. Click rate{" "}
                          {fmtPct(c.click_rate)}.
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <div className="pw-dash-secondary-empty pw-dash-secondary-empty-action">
              <span>
                <strong>No campaigns yet</strong>
                <span>Your newest drafts and sends will appear here.</span>
              </span>
              <button
                type="button"
                className="btn pw-dash-secondary-action"
                onClick={() => {
                  setPendingCampaignDraft({});
                  setSection("campaigns");
                }}
              >
                Create campaign
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function CampaignLoadNotice({
  loading,
  onRetry,
  stale,
}: {
  loading: boolean;
  onRetry: Props["onRetry"];
  stale: boolean;
}): ReactElement {
  return (
    <div className="pw-dash-secondary-error" role="alert">
      <span>
        <strong>
          {stale
            ? "Recent campaigns couldn't be refreshed"
            : "Recent campaigns are unavailable"}
        </strong>
        <span>
          {stale
            ? "Showing the last confirmed campaign list."
            : "Check your connection, then try this list again."}
        </span>
      </span>
      {onRetry ? (
        <button
          type="button"
          className="btn btn-sm pw-dash-secondary-action"
          onClick={() => void onRetry()}
          disabled={loading}
        >
          {loading ? "Retrying…" : "Try again"}
        </button>
      ) : null}
    </div>
  );
}

function campaignStatus(campaign: Campaign): string {
  const status =
    typeof campaign.status === "string" ? campaign.status.trim() : "";
  if (status) return status;
  return typeof campaign.sent_at === "string" && campaign.sent_at
    ? "Sent"
    : "Campaign";
}

function campaignName(campaign: Campaign): string {
  if (typeof campaign.name === "string" && campaign.name.trim()) {
    return campaign.name;
  }
  if (typeof campaign.subject === "string" && campaign.subject.trim()) {
    return campaign.subject;
  }
  return "Untitled";
}

function campaignDate(campaign: Campaign): string | undefined {
  if (typeof campaign.sent_at === "string") return campaign.sent_at;
  return typeof campaign.created_at === "string"
    ? campaign.created_at
    : undefined;
}

function safeCampaignId(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}
