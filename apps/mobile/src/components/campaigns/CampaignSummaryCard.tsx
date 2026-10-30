/**
 * CampaignSummaryCard — who this campaign is, when it goes out, and (via
 * CampaignAudienceRow) who it goes to.
 *
 * Extracted from the 826-line campaigns/[id].tsx. The status pill now renders
 * a human label ("Sent", not the raw engine word "running") and timestamps
 * are relative with the absolute value preserved in the accessibility label.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { Card } from "@/components/campaigns/CampaignDetailControls";
import { CampaignAudienceRow } from "@/components/campaigns/CampaignAudienceRow";
import {
  campaignRowDate,
  campaignStatusLabel,
  campaignTone,
} from "@/lib/campaignFormat";
import { isCampaignAbTest } from "@/lib/campaignAbTest";
import { campaignFromLine, campaignReplyTo } from "@/lib/campaignSender";
import type { SendPreviewResponse } from "@/lib/campaignSendPreview";
import type { CampaignDetail } from "@/hooks/useCampaigns";
import { dateTime, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface CampaignSummaryCardProps {
  campaign: CampaignDetail;
  /** Resolved audience, when the send-preview endpoint answered. */
  preview: SendPreviewResponse | null | undefined;
  previewLoading: boolean;
  /** The send-preview read errored or never ran (offline / gated). */
  previewUnavailable?: boolean | undefined;
}

/** Subject, internal name and preview text — the campaign's identity. */
function CampaignIdentity({ campaign: c }: { campaign: CampaignDetail }) {
  const { t } = useTheme();
  const showName = Boolean(c.name && c.subject && c.name !== c.subject);
  const previewText = (c.preview_text ?? "").trim();
  return (
    <>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          fontSize: 11,
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        CAMPAIGN
      </Text>
      <Text
        {...typeCap("heading")}
        style={{
          color: t.fg,
          fontSize: 18,
          fontWeight: "700",
          fontFamily: FONT.bold,
          marginTop: 4,
          // Tenant content can be RTL — a Hebrew or Arabic subject must not
          // render into a left-aligned Latin-ordered line.
          writingDirection: "auto",
        }}
        numberOfLines={3}
      >
        {/* name-first, as desktop and CampaignListRow do. */}
        {c.name || c.subject || "Untitled"}
      </Text>
      {showName ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            fontSize: 13,
            marginTop: 2,
            fontFamily: FONT.regular,
            writingDirection: "auto",
          }}
          numberOfLines={2}
        >
          {c.name}
        </Text>
      ) : null}
      {previewText.length > 0 ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            fontSize: 12,
            marginTop: 6,
            fontFamily: FONT.regular,
            writingDirection: "auto",
          }}
          numberOfLines={2}
        >
          Preview: {previewText}
        </Text>
      ) : null}
    </>
  );
}

/** Status pill, badges, and the correctly-labelled timestamp. */
function CampaignStatusLine({ campaign: c }: { campaign: CampaignDetail }) {
  const { t } = useTheme();
  const when = campaignRowDate(c);
  const status = (c.status ?? "draft").toLowerCase();
  const scheduled =
    !c.sent_at && c.scheduled_at && status === "scheduled"
      ? c.scheduled_at
      : null;
  return (
    <>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          marginTop: 12,
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Pill
          label={campaignStatusLabel(c.status)}
          tone={campaignTone(c.status)}
          size="md"
        />
        {isCampaignAbTest(c) ? (
          <Pill label="A/B" tone="info" size="md" />
        ) : null}
        {c.per_recipient_optimize ? (
          <Pill label="Personalized send" tone="info" size="md" />
        ) : null}
        {when ? (
          <Text
            {...typeCap("numeric")}
            accessibilityLabel={`${when.prefix} ${when.absolute}`}
            style={{
              color: t.fgSubtle,
              fontSize: 12,
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
            }}
          >
            {when.prefix} {when.relative}
          </Text>
        ) : null}
      </View>
      {scheduled ? (
        <Text
          {...typeCap("numeric")}
          accessibilityLabel={`Scheduled for ${dateTime(scheduled)}`}
          style={{
            color: t.warning,
            fontSize: 12,
            marginTop: 8,
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
        >
          Scheduled for {dateTime(scheduled)} ({relativeTime(scheduled)})
        </Text>
      ) : null}
    </>
  );
}

/**
 * From / Reply-to. Read through campaignSender because the sending address
 * lives at `delivery_settings.from_email`, not as a top-level column — this
 * block used to key off a `from_email` field the API has never sent, so it
 * never rendered.
 */
function CampaignSenderLines({ campaign: c }: { campaign: CampaignDetail }) {
  const { t } = useTheme();
  const from = campaignFromLine(c);
  const replyTo = campaignReplyTo(c);
  if (!from && !replyTo) return null;
  // `label` is the role for a field sublabel: prose that reflows, so it earns
  // the scale's most generous ceiling. Both lines wrap to two — an address
  // like "no-reply@transactional.example.com" already truncates at one line at
  // the DEFAULT text size, let alone a raised one.
  const muted = {
    color: t.fgMuted,
    ...typeStyle("label"),
    marginTop: 8,
    fontFamily: FONT.regular,
  } as const;
  return (
    <>
      {from ? (
        <Text {...typeCap("label")} style={muted} numberOfLines={2}>
          From: {from}
        </Text>
      ) : null}
      {replyTo ? (
        <Text
          {...typeCap("label")}
          style={{ ...muted, marginTop: 2 }}
          numberOfLines={2}
        >
          Replies go to: {replyTo}
        </Text>
      ) : null}
    </>
  );
}

export function CampaignSummaryCard({
  campaign: c,
  preview,
  previewLoading,
  previewUnavailable = false,
}: CampaignSummaryCardProps) {
  return (
    <Card>
      <CampaignIdentity campaign={c} />
      <CampaignStatusLine campaign={c} />
      <CampaignAudienceRow
        preview={preview}
        loading={previewLoading}
        unavailable={previewUnavailable}
        {...(c.list_id ? { listId: c.list_id } : {})}
        {...(c.segment_id ? { segmentId: c.segment_id } : {})}
      />
      <CampaignSenderLines campaign={c} />
    </Card>
  );
}
