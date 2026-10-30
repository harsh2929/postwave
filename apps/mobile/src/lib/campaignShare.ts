/**
 * lib/campaignShare.ts — what goes into the system share sheet.
 *
 * Two gaps, one primitive:
 *
 *  - There was no way to share the published campaign. The Archive tab
 *    already builds public issue URLs and drives Share correctly; the campaign
 *    detail screen simply never wired the same plumbing to
 *    `archive_public` / `archive_slug`.
 *  - There was no way to share the RESULTS. "Here's how the send did" pasted
 *    into Slack from a phone is a natural, high-frequency act that no client
 *    made easy.
 *
 * Pure so the copy is unit-tested rather than assembled inline in a handler.
 */
import { campaignCount, campaignRate } from "@/lib/campaignFormat";

export interface CampaignShareInput {
  subject?: string | null | undefined;
  name?: string | null | undefined;
  sent?: number | undefined;
  openRate?: number | undefined;
  clickRate?: number | undefined;
  bounces?: number | undefined;
  /** Public web-version URL, when the campaign has been published. */
  archiveUrl?: string | null | undefined;
}

export function campaignShareTitle(
  input: Pick<CampaignShareInput, "subject" | "name">,
): string {
  const subject = (input.subject ?? "").trim();
  if (subject) return subject;
  const name = (input.name ?? "").trim();
  return name || "Campaign";
}

/**
 * A short, pasteable summary. Metric lines are omitted entirely when the
 * value is absent — a share that says "Open rate: —" is worse than one that
 * doesn't mention open rate.
 */
export function campaignShareText(input: CampaignShareInput): string {
  const lines: string[] = [campaignShareTitle(input)];

  const metrics: string[] = [];
  if (typeof input.sent === "number" && Number.isFinite(input.sent)) {
    metrics.push(`Sent ${campaignCount(input.sent)}`);
  }
  if (typeof input.openRate === "number" && Number.isFinite(input.openRate)) {
    metrics.push(`Open ${campaignRate(input.openRate, { scale: "percent" })}`);
  }
  if (typeof input.clickRate === "number" && Number.isFinite(input.clickRate)) {
    metrics.push(`Click ${campaignRate(input.clickRate, { scale: "percent" })}`);
  }
  if (typeof input.bounces === "number" && Number.isFinite(input.bounces)) {
    metrics.push(`Bounces ${campaignCount(input.bounces)}`);
  }
  if (metrics.length > 0) lines.push(metrics.join(" · "));

  const url = (input.archiveUrl ?? "").trim();
  if (url) lines.push(url);

  return lines.join("\n");
}

/** True when the campaign has a shareable public web version. */
export function hasPublicArchive(campaign: {
  archive_public?: boolean | undefined;
  archive_slug?: string | undefined;
}): boolean {
  return (
    campaign.archive_public === true &&
    typeof campaign.archive_slug === "string" &&
    campaign.archive_slug.trim().length > 0
  );
}
