/**
 * CampaignAudienceCard — WHO this campaign sends to, stated before you send.
 *
 * Two gaps this closes, from the same server read
 * (GET /api/v1/campaigns/{id}/send-preview):
 *
 *   - The send confirmation showed no audience at all. The recipient count
 *     appeared ONLY after the send, in the success alert. On a phone, where a
 *     mis-tap is likeliest, that is the one number that matters.
 *   - The detail screen never displayed the list or segment either, so an
 *     operator could tap "Send now" with no indication of the audience — not
 *     the list name, not the segment, not even whether it was workspace-wide.
 *
 * The Go wire contract uses **-1 as an "unavailable" sentinel**; those render
 * as a dash so the operator sees the gap rather than an inflated zero. See
 * src/lib/campaignSendPreview.ts.
 */
import { ActivityIndicator, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { StatRow } from "@/components/campaigns/CampaignDetailControls";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import {
  audienceKindLabel,
  audienceLabel,
  previewCountLabel,
  summarizeSendPreview,
  type SendPreviewResponse,
} from "@/lib/campaignSendPreview";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface CampaignAudienceCardProps {
  preview: SendPreviewResponse | null | undefined;
  loading: boolean;
  error: unknown;
  /** Compact form drops the per-metric rows — used inline in the send sheet. */
  compact?: boolean;
}

export function CampaignAudienceCard({
  preview,
  loading,
  error,
  compact = false,
}: CampaignAudienceCardProps) {
  const { t } = useTheme();

  const container = {
    backgroundColor: t.surface,
    borderColor: t.borderSubtle,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  } as const;

  if (loading) {
    return (
      <View style={container} accessibilityLabel="Resolving the audience">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ActivityIndicator size="small" color={t.fgMuted} />
          <Text
            {...typeCap("bodySmall")}
            style={{ color: t.fgMuted, fontSize: 13, fontFamily: FONT.regular }}
          >
            Counting who receives this…
          </Text>
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={container} accessibilityLabel="Audience unavailable">
        <Text
          {...typeCap("bodySmall")}
          style={{ color: t.warning, fontSize: 13, fontFamily: FONT.semibold }}
        >
          Audience couldn&apos;t be counted
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            fontSize: 12,
            marginTop: 4,
            lineHeight: 17,
            fontFamily: FONT.regular,
          }}
        >
          {campaignErrorMessage(error, "Couldn't resolve the audience.")}
        </Text>
      </View>
    );
  }

  if (!preview) {
    return (
      <View style={container} accessibilityLabel="Audience unavailable">
        <Text
          {...typeCap("label")}
          style={{ color: t.fgMuted, fontSize: 12, fontFamily: FONT.regular }}
        >
          The audience preview isn&apos;t available on this workspace. Check the
          list on the web app before sending.
        </Text>
      </View>
    );
  }

  const summary = summarizeSendPreview(preview);
  const kind = audienceKindLabel(preview);

  return (
    <View
      style={container}
      accessible
      accessibilityLabel={`Audience: ${audienceLabel(preview)}. ${summary.sentence}.`}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            fontSize: 11,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            fontFamily: FONT.semibold,
          }}
        >
          Audience
        </Text>
        {kind ? <Pill label={kind} tone="neutral" /> : null}
        {summary.overCap ? <Pill label="Over cap" tone="danger" /> : null}
      </View>

      <Text
        {...typeCap("body")}
        style={{
          color: t.fg,
          fontSize: 15,
          marginTop: 4,
          fontFamily: FONT.semibold,
        }}
        numberOfLines={2}
      >
        {audienceLabel(preview)}
      </Text>
      <Text
        {...typeCap("numeric")}
        style={{
          color: t.fgMuted,
          fontSize: 12,
          marginTop: 2,
          lineHeight: 17,
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
      >
        {summary.sentence}
      </Text>

      {summary.capWarning ? (
        <View
          style={{
            backgroundColor: t.bgSubtle,
            borderColor: t.danger,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 10,
            paddingVertical: 8,
            marginTop: 8,
          }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.danger,
              fontSize: 12,
              lineHeight: 17,
              fontFamily: FONT.medium,
            }}
          >
            {summary.capWarning}
          </Text>
        </View>
      ) : null}

      {compact ? null : (
        <View style={{ marginTop: 6 }}>
          <StatRow
            label="Recipients"
            value={previewCountLabel(preview.recipients)}
            t={t}
          />
          <StatRow
            label="Suppressed (excluded)"
            value={previewCountLabel(preview.suppressed_excluded)}
            t={t}
          />
          <StatRow
            label="Will be emailed"
            value={
              summary.deliverable === null
                ? "—"
                : previewCountLabel(summary.deliverable)
            }
            t={t}
          />
          <StatRow
            label="Remaining in today's cap"
            value={previewCountLabel(preview.tier_cap_remaining)}
            t={t}
            last
          />
        </View>
      )}
    </View>
  );
}
