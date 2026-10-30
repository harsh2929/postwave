/**
 * hooks/useCampaignShare.ts — the campaign's public web-version URL and the
 * system share sheet.
 *
 * Two gaps, one hook:
 *  - There was no way to share the published campaign, even though the
 *    Archive tab already builds public issue URLs and drives Share correctly
 *    — the detail screen simply never wired the same plumbing to
 *    `archive_public` / `archive_slug`.
 *  - There was no way to share the RESULTS. Pasting "here's how the send did"
 *    into Slack from a phone is a natural, frequent act no client made easy.
 */
import { useCallback, useMemo } from "react";
import { Share } from "react-native";

import { useToast } from "@/components/Toast";
import { useArchiveTenantSettings } from "@/hooks/useArchiveOps";
import type { CampaignDetail, CampaignReport } from "@/hooks/useCampaigns";
import { archiveIssueURL } from "@/lib/archiveLinks";
import {
  effectiveEngagementMode,
  engagementFigures,
} from "@/lib/campaignEngagement";
import { campaignShareText, hasPublicArchive } from "@/lib/campaignShare";

export interface CampaignShare {
  /** Non-null when the campaign has a shareable public web version. */
  archiveUrl: string | null;
  share: () => void;
}

export function useCampaignShare(
  campaign: CampaignDetail | undefined,
  report: CampaignReport | null | undefined,
): CampaignShare {
  const { toast } = useToast();
  // The public archive resolves `tenant_archive_slug` (or a verified vanity
  // `archive_domain`) — NOT the auth workspace slug this hook used to pass,
  // which is a different, independently-set column. See src/lib/archiveLinks.ts.
  const settings = useArchiveTenantSettings();
  const identity = settings.data;

  const archiveUrl = useMemo(() => {
    if (!campaign || !identity) return null;
    if (!hasPublicArchive(campaign)) return null;
    return archiveIssueURL(identity, campaign.archive_slug ?? "");
  }, [campaign, identity]);

  const share = useCallback(() => {
    if (!campaign) return;
    // Human (MPP-stripped) rates when the report has them, so a shared number
    // matches what the operator is looking at and what desktop shows.
    //
    // `report.human_open_rate ?? report.open_rate` looked like it did this and
    // did the opposite: the nine human_* fields carry no `omitempty` in
    // apps/api/internal/analytics/analytics.go, so they are ALWAYS on the wire
    // and are ZERO unless POSTWAVE_HUMAN_ENGAGEMENT is on (off by default).
    // `??` fires on null/undefined and never on 0, so every share pasted
    // "Open 0.0% · Click 0.0%" for a campaign that had really opened at 41%.
    // engagementFigures + the evidence gate in lib/campaignEngagement.ts are
    // the same pair the Performance section renders through, so the shared
    // text and the screen it was shared from now cannot disagree.
    const figures = engagementFigures(
      report,
      effectiveEngagementMode(report, "human"),
    );
    const message = campaignShareText({
      subject: campaign.subject,
      name: campaign.name,
      sent: report?.sent,
      openRate: figures.openRate,
      clickRate: figures.clickRate,
      bounces: report?.bounces,
      archiveUrl,
    });
    const content = archiveUrl ? { message, url: archiveUrl } : { message };
    void Share.share(content, { dialogTitle: "Share campaign" }).catch(() =>
      toast({ kind: "error", message: "Couldn't open the share sheet." }),
    );
  }, [archiveUrl, campaign, report, toast]);

  return { archiveUrl, share };
}
