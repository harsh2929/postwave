/**
 * CampaignAudienceRow — "who does this go to?", stated on the detail screen.
 *
 * `list_id` and `segment_id` were already on the type and were already read
 * when building an A/B test, but nothing on the screen ever displayed them —
 * so a phone operator could tap "Send now" with no indication of the list,
 * the segment, or even whether the send was workspace-wide.
 *
 * When the send-preview endpoint answers, this shows the resolved label and
 * the real counts. When it does not, it still says whether an audience is set
 * at all — which is the difference between "a list" and "nobody".
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import {
  audienceKindLabel,
  campaignAudienceHeadline,
  summarizeSendPreview,
  type SendPreviewResponse,
} from "@/lib/campaignSendPreview";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface CampaignAudienceRowProps {
  preview: SendPreviewResponse | null | undefined;
  loading: boolean;
  /**
   * The send-preview read errored or never ran (offline / gated). Without it
   * the row states "no list or segment" from a lack of signal — see
   * campaignAudienceHeadline.
   */
  unavailable?: boolean | undefined;
  /** Whether the campaign row itself carries a list or segment id. */
  listId?: string | undefined;
  segmentId?: string | undefined;
}

export function CampaignAudienceRow({
  preview,
  loading,
  unavailable = false,
  listId,
  segmentId,
}: CampaignAudienceRowProps) {
  const { t } = useTheme();
  const summary = preview ? summarizeSendPreview(preview) : null;
  const kind = audienceKindLabel(preview);
  const headline = campaignAudienceHeadline({
    preview,
    loading,
    unavailable,
    listId,
    segmentId,
  });

  return (
    <View
      accessible
      accessibilityLabel={
        summary
          ? `Audience: ${headline}. ${summary.sentence}.`
          : `Audience: ${headline}`
      }
      style={{
        marginTop: 12,
        paddingTop: 10,
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
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
      </View>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          fontSize: 13,
          marginTop: 4,
          fontFamily: FONT.medium,
        }}
        numberOfLines={2}
      >
        {headline}
      </Text>
      {summary ? (
        <Text
          {...typeCap("numeric")}
          style={{
            color: t.fgSubtle,
            fontSize: 12,
            marginTop: 2,
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
        >
          {summary.sentence}
        </Text>
      ) : null}
    </View>
  );
}
