/**
 * RecentCampaignRow — one row of the dashboard's "Recent campaigns" card.
 *
 * Dates go through `date()` from lib/format, which includes the YEAR and
 * returns an em-dash for the empty strings this API sends. The screen-local
 * formatter it replaces emitted `{month, day}`, so a 2024 campaign rendered as
 * "Jan 3" — indistinguishable from this January — and an absent timestamp
 * rendered as the raw string. The full instant is carried on the row's spoken
 * label, where there is room for it.
 *
 * The row also carries HOW THE CAMPAIGN DID, not only when it went out. Open
 * and click rate ride on every list row the dashboard already fetches
 * (`attachListRates` in apps/api/internal/campaigns/repo.go), so a date-only
 * row was throwing away the answer to the question the reader opened the app
 * to ask. Which rows may claim a rate — and why an absent rate means something
 * different on a sent campaign than on a draft — is decided in
 * lib/recentCampaignRow, where it is testable without React Native.
 */
import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import type { Campaign } from "@/hooks/useCampaigns";
import { campaignStatusLabel, campaignTone } from "@/lib/campaignFormat";
import { FONT } from "@/lib/fonts";
import {
  recentCampaignRowLabel,
  recentCampaignRowSummary,
} from "@/lib/recentCampaignRow";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * Re-exported from the campaigns cluster's single formatting vocabulary.
 *
 * This file used to carry its OWN copy, and it had drifted: it knew nothing
 * about `paused`, `cancelled` or `finished`, so the same campaign showed a
 * neutral pill on the dashboard and a warning/danger pill on the campaigns
 * list — the exact divergence src/lib/campaignFormat.ts exists to end.
 */
export { campaignTone };

export function RecentCampaignRow({ campaign }: { campaign: Campaign }) {
  const { t } = useTheme();
  // name-first, as desktop and the campaigns list do.
  const title = campaign.name || campaign.subject || "Untitled";
  const status = campaignStatusLabel(campaign.status);
  const when = campaign.sent_at ?? campaign.created_at;
  const metrics = {
    status: campaign.status,
    when,
    openRate: campaign.open_rate,
    clickRate: campaign.click_rate,
  };
  const { detail } = recentCampaignRowSummary(metrics);

  return (
    <Link
      href={{
        pathname: "/(tabs)/campaigns/[id]",
        params: { id: String(campaign.id) },
      }}
      asChild
    >
      <Pressable
        accessibilityRole="button"
        // One composed announcement per row rather than four fragments ending
        // in two bare percentages with no referent.
        accessibilityLabel={`${recentCampaignRowLabel(title, {
          ...metrics,
          statusLabel: status,
        })}. Open campaign.`}
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          padding: 14,
          marginBottom: 10,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
              flex: 1,
            }}
            numberOfLines={1}
          >
            {title}
          </Text>
          <Pill label={status} tone={campaignTone(campaign.status)} />
        </View>
        <Text
          {...typeCap("numeric")}
          style={{
            color: t.fgMuted,
            ...typeStyle("numeric"),
            marginTop: 6,
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
          // The spoken label above already carries all of this in full; letting
          // VoiceOver reach the compact line too would read the rates twice.
          importantForAccessibility="no-hide-descendants"
          numberOfLines={1}
        >
          {detail}
        </Text>
      </Pressable>
    </Link>
  );
}
