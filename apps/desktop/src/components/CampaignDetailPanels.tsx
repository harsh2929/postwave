import type { ReactElement } from "react";

import {
  type CampaignDetail,
  type CampaignReport,
  createABTestCampaign,
  resendUnopenedApi,
} from "../lib/api-client";
import type { SseStatus } from "../lib/sse";
import { writeClipboardText } from "../lib/clipboard";
import { ExternalLink } from "./ExternalLink";
import { CampaignAISummaryCard } from "./CampaignAISummaryCard";
import { EngagementModeToggle } from "./CampaignDetailActionModals";
import { LiveDot } from "./LiveDot";
import { toast } from "./Toast";

export type CampaignEngagementMode = "raw" | "human";

function formatPercent(value: number | undefined | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  const percent = value > 1 ? value : value * 100;
  return `${percent.toFixed(1)}%`;
}

function formatNumber(value: number | undefined | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString();
}

export function campaignReportTopLinks(
  report: CampaignReport | null,
  mode: CampaignEngagementMode,
): NonNullable<CampaignReport["top_links"]> {
  if (!report) return [];
  return mode === "human"
    ? (report.human_top_links ?? report.top_links ?? [])
    : (report.top_links ?? []);
}

export function CampaignPerformancePanel({
  loading,
  isDraft,
  hasReport,
  liveStatus,
  report,
  reportErr,
  engagementMode,
  onEngagementModeChange,
}: {
  loading: boolean;
  isDraft: boolean;
  hasReport: boolean;
  liveStatus: SseStatus;
  report: CampaignReport | null;
  reportErr: string | null;
  engagementMode: CampaignEngagementMode;
  onEngagementModeChange: (mode: CampaignEngagementMode) => void;
}): ReactElement {
  if (loading) {
    return (
      <div>
        <div className="label">Performance</div>
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="skel"
            style={{ height: 14, margin: "6px 0" }}
          />
        ))}
      </div>
    );
  }

  if (isDraft && !hasReport) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        Performance metrics appear after the campaign sends.
      </div>
    );
  }

  const topLinks = campaignReportTopLinks(report, engagementMode);
  const hasHumanCounts = Boolean(
    report &&
    ((report.human_opens ?? 0) > 0 ||
      (report.bot_signatures_applied?.length ?? 0) > 0),
  );

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <div className="label" style={{ marginBottom: 0 }}>
          Performance
        </div>
        {!isDraft && liveStatus !== "closed" ? (
          <LiveDot status={liveStatus} />
        ) : null}
        {hasHumanCounts ? (
          <EngagementModeToggle
            value={engagementMode}
            onChange={onEngagementModeChange}
          />
        ) : null}
      </div>

      {reportErr && !report ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Report unavailable: {reportErr}
        </div>
      ) : (
        <>
          <div className="campaign-stats">
            <div className="stat-card">
              <span className="stat-label">Sent</span>
              <span className="stat-value">{formatNumber(report?.sent)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Delivered</span>
              <span className="stat-value">
                {formatNumber(report?.delivered)}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Open rate</span>
              <span className="stat-value">
                {formatPercent(
                  engagementMode === "human"
                    ? report?.human_open_rate
                    : report?.open_rate,
                )}
              </span>
              {engagementMode === "human" &&
              report &&
              (report.bot_signatures_applied?.length ?? 0) > 0 ? (
                <span
                  className="muted"
                  style={{ fontSize: 10, marginTop: 2, display: "block" }}
                  title={(report.bot_signatures_applied ?? []).join(", ")}
                >
                  MPP-stripped
                </span>
              ) : null}
            </div>
            <div className="stat-card">
              <span className="stat-label">Click rate</span>
              <span className="stat-value">
                {formatPercent(
                  engagementMode === "human"
                    ? report?.human_click_rate
                    : report?.click_rate,
                )}
              </span>
            </div>
          </div>

          {topLinks.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="label">Top links</div>
              <table className="link-table">
                <tbody>
                  {topLinks.slice(0, 5).map((link, index) => (
                    <tr key={`${link.url}-${index}`}>
                      <td
                        className="muted"
                        title={link.url}
                        style={{
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          maxWidth: 280,
                        }}
                      >
                        {link.url}
                      </td>
                      <td className="tabular">{link.clicks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="link-table" style={{ marginTop: 12 }}>
            <div className="link-meta-row">
              <span className="muted">Bounces</span>
              <span className="tabular">{formatNumber(report?.bounces)}</span>
            </div>
            <div className="link-meta-row">
              <span className="muted">Complaints</span>
              <span className="tabular">
                {formatNumber(report?.complaints)}
              </span>
            </div>
            <div className="link-meta-row">
              <span className="muted">Unsubscribes</span>
              <span className="tabular">
                {formatNumber(report?.unsubscribes)}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function campaignArchiveUrl(
  archiveBase: string | null,
  archiveSlug: string | null | undefined,
): string | null {
  return archiveBase && archiveSlug
    ? `${archiveBase}/${encodeURIComponent(archiveSlug)}`
    : null;
}

export function CampaignWebVersionCard({
  archiveBase,
  archiveSettingsLoaded,
  archiveSlug,
}: {
  archiveBase: string | null;
  archiveSettingsLoaded: boolean;
  archiveSlug: string;
}): ReactElement {
  const archiveUrl = campaignArchiveUrl(archiveBase, archiveSlug);
  return (
    <div
      style={{
        marginTop: 16,
        padding: "8px 12px",
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
      }}
    >
      <span className="badge accent">Web version</span>
      {archiveUrl ? (
        <>
          <ExternalLink
            href={archiveUrl}
            className="mono"
            style={{
              flex: 1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={archiveUrl}
          >
            {archiveUrl}
          </ExternalLink>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              writeClipboardText(archiveUrl, {
                contentClass: "public",
                label: "Web version URL",
              })
                .then((result) => {
                  if (result.ok) toast.success("Web version URL copied");
                  else toast.error(result.message);
                })
                .catch(() =>
                  toast.error("The web version URL couldn't be copied."),
                );
            }}
          >
            Copy link
          </button>
        </>
      ) : archiveSettingsLoaded ? (
        <span className="muted" style={{ flex: 1 }}>
          Set your archive slug in Settings → Public archive to get the
          shareable web URL.
        </span>
      ) : (
        <span className="muted" style={{ flex: 1 }}>
          Resolving public URL…
        </span>
      )}
    </div>
  );
}

export function resendSubject(subject: string | null | undefined): string {
  return subject ? `Re: ${subject}` : "Re: your last campaign";
}

export function CampaignPostSendSummary({
  campaignId,
  detail,
  status,
  canMutate,
}: {
  campaignId: string | number;
  detail: CampaignDetail;
  status: string;
  canMutate: boolean;
}): ReactElement | null {
  if (status !== "sent" && status !== "completed") return null;

  return (
    <CampaignAISummaryCard
      campaignId={campaignId}
      canMutate={canMutate}
      onResendNonOpeners={async () => {
        const result = await resendUnopenedApi.resend(campaignId, {
          subject: resendSubject(detail.subject),
          send_after_hours: 48,
        });
        if (result.error) {
          toast.error(`Couldn't schedule resend: ${result.error.message}`);
          return;
        }
        toast.success({
          message: "Resend scheduled",
          detail: `${result.data.audience_size} non-openers will get "${result.data.subject}" in 48h.`,
        });
      }}
      onABTest={async () => {
        const name = detail.name?.trim();
        if (!name) {
          toast.error("Name the campaign before running an A/B test.");
          return;
        }
        const baseSubject = (detail.subject ?? "").trim();
        if (!baseSubject) {
          toast.error("Set a subject before running an A/B test.");
          return;
        }
        const abName = `${name} (subject test)`;
        const result = await createABTestCampaign({
          name: abName,
          subject_variants: [baseSubject, `Re: ${baseSubject}`],
          body_html:
            typeof detail.body_html === "string" ? detail.body_html : "",
          from_name: detail.from_name ?? undefined,
        });
        if (result.error) {
          toast.error(`Couldn't create A/B test: ${result.error.message}`);
          return;
        }
        toast.success({
          message: `A/B test "${abName}" created`,
          detail: `${result.data.children.length} arms ready — refine the variants before sending.`,
        });
      }}
    />
  );
}
