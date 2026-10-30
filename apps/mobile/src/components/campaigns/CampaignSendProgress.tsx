/**
 * CampaignSendProgress — the live send, while it is live.
 *
 * A campaign in `sending` rendered exactly like one that had finished: four
 * frozen tiles, no denominator, no motion, nothing that said "this is still
 * running". The numbers to say it already existed — `report.sent` and the
 * audience count the send sheet reads — they were simply never put together.
 *
 * The bar is decorative: the counts are stated as text and the whole block
 * carries an exact spoken label, so nothing here depends on seeing a colour
 * or a width.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { sendProgress } from "@/lib/campaignProgress";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface CampaignSendProgressProps {
  status: string | null | undefined;
  sent: number | null | undefined;
  delivered: number | null | undefined;
  /** Audience size from the send-preview read the detail screen already makes. */
  audience: number | null | undefined;
}

export function CampaignSendProgress({
  status,
  sent,
  delivered,
  audience,
}: CampaignSendProgressProps) {
  const { t } = useTheme();
  const progress = sendProgress({ status, sent, delivered, audience });
  if (!progress.live) return null;

  return (
    <View
      accessible
      accessibilityLabel={`Sending in progress. ${progress.spoken}`}
      accessibilityLiveRegion="polite"
      style={{
        backgroundColor: t.surface,
        borderColor: t.warning,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginTop: 12,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <Pill label="Sending" tone="warning" />
        <Text
          {...typeCap("mono")}
          style={{
            color: t.fg,
            fontSize: 13,
            fontFamily: FONT.medium,
            fontVariant: ["tabular-nums"],
            flex: 1,
          }}
        >
          {progress.headline}
        </Text>
      </View>

      {progress.fraction !== null ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{
            height: 6,
            borderRadius: 3,
            backgroundColor: t.borderSubtle,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              width: `${Math.round(progress.fraction * 100)}%`,
              height: 6,
              backgroundColor: t.warning,
            }}
          />
        </View>
      ) : null}

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontSize: 11,
          lineHeight: 16,
          marginTop: 8,
          fontFamily: FONT.regular,
        }}
      >
        These numbers refresh while this screen is open. Pausing stops delivery
        for the recipients who haven&apos;t been reached yet.
      </Text>
    </View>
  );
}
