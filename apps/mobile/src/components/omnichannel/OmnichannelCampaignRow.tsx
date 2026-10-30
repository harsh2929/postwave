/**
 * OmnichannelCampaignRow — one cross-channel definition, as a list row.
 *
 * THE ROW'S JOB IS THE SPAN. "Which channels does this definition touch" is the
 * only question that makes an omnichannel list different from the campaign list
 * mobile already has, so the channel chips lead and everything else supports
 * them.
 *
 * THE STATUS PILL IS NEUTRAL ON PURPOSE. Nothing dispatches these — the
 * package's runtime is fail-closed by a compile-time constant — so a green
 * "sent" or a live-looking "sending" would be a claim about delivery that no
 * component of this system is in a position to make. Statuses that READ as
 * live get the muted treatment plus the screen-level caveat; only "draft" and
 * "ready", which are honest authoring states, are styled as themselves.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { date as fmtDate } from "@/lib/format";
import {
  channelSpan,
  pathStatusIsRuntimeClaim,
  trafficSplit,
  type OmniCampaignDefinition,
} from "@/lib/omnichannelDefinitions";
import { channelLabel, channelSpanSpeech } from "@/lib/omnichannelLabels";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function OmnichannelCampaignRow({
  campaign,
  onPress,
}: {
  campaign: OmniCampaignDefinition;
  onPress: (campaign: OmniCampaignDefinition) => void;
}) {
  const { t } = useTheme();
  const channels = channelSpan(campaign);
  const split = trafficSplit(campaign);
  const claimsLive = pathStatusIsRuntimeClaim(campaign.status);
  const updated = campaign.updatedAt ? fmtDate(campaign.updatedAt) : null;

  return (
    <Pressable
      onPress={() => onPress(campaign)}
      accessibilityRole="button"
      accessibilityLabel={`${campaign.name}. ${campaign.status}. ${channelSpanSpeech(channels)}.`}
      accessibilityHint="Opens the paths this definition declares"
      style={{
        gap: 8,
        padding: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        backgroundColor: t.surface,
        marginBottom: 10,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 10,
        }}
      >
        <Text
          {...typeCap("body")}
          numberOfLines={2}
          style={{
            flex: 1,
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.medium,
          }}
        >
          {campaign.name}
        </Text>
        <Pill
          label={campaign.status}
          tone={claimsLive ? "neutral" : campaign.status === "ready" ? "info" : "neutral"}
        />
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {channels.map((channel) => (
          <Pill key={channel} label={channelLabel(channel)} tone="accent" />
        ))}
      </View>

      <Text
        {...typeCap("caption")}
        numberOfLines={2}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {[
          `${campaign.paths.length} ${campaign.paths.length === 1 ? "path" : "paths"}`,
          campaign.objective,
          split.declared && !split.balanced ? "traffic split incomplete" : null,
          updated ? `updated ${updated}` : null,
        ]
          .filter((part): part is string => Boolean(part))
          .join(" · ")}
      </Text>
    </Pressable>
  );
}
