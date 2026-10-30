/**
 * ActiveSendStrip — the dashboard's answer to "is it going out right now?".
 *
 * Pinned above everything else on the screen, because an in-flight send is the
 * highest-attention state the product has and it is the state you are most
 * likely to be checking on from a phone. It renders NOTHING when no campaign
 * is sending, so the dashboard keeps its normal shape the other 99% of the
 * time — the same self-gating rule the forecast strip and the anomaly card
 * follow.
 *
 * Every decision about what it may claim lives in `lib/activeSend`, so the
 * "no report yet" / "read failed" / "no denominator" branches are unit-tested
 * without a renderer. This file lays out strings and owns two queries.
 *
 * WHY IT OWNS ITS QUERIES: they must not run when nothing is sending. Hoisting
 * them into `useDashboardScreen` would fire a report read and a send-preview
 * on every dashboard mount for every workspace, which is the opposite of the
 * bargain — the strip costs one report poll while a send is live and zero the
 * rest of the time.
 *
 * The bar is decorative. The counts are stated as text, the state is carried
 * by the word "Sending now" as well as the tone, and the whole block has one
 * composed spoken sentence — nothing here depends on seeing a colour.
 */
import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import type { Campaign } from "@/hooks/useCampaigns";
import { useCampaignReport } from "@/hooks/useCampaigns";
import { useCampaignSendPreview } from "@/hooks/useCampaignSendChecks";
import { activeSendView, pickActiveSend } from "@/lib/activeSend";
import { summarizeSendPreview } from "@/lib/campaignSendPreview";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { msg } from "@/lib/i18n";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ActiveSendStripProps {
  /** The dashboard's existing campaigns list. No extra request to find one. */
  campaigns: readonly Campaign[] | undefined;
}

export function ActiveSendStrip({ campaigns }: ActiveSendStripProps) {
  const { t } = useTheme();
  const selection = pickActiveSend(campaigns);
  const campaign = selection?.campaign;

  // Both hooks run unconditionally and both are disabled without an id, so the
  // early return below cannot change the hook order between renders. The
  // report re-reads itself on LIVE_SEND_POLL_MS purely because `status` says
  // the send is live (see useCampaignReport).
  const report = useCampaignReport(campaign?.id, {
    ...(campaign?.status === undefined ? {} : { status: campaign.status }),
  });
  // The audience total does not move during a send, so this is one read, not a
  // poll. It is `ScopeReadCampaigns` / viewer-minimum on both authorisation
  // layers — the same floor as the campaign list this strip is derived from —
  // so it never buys a guaranteed 403 for a reader who can see the dashboard.
  const preview = useCampaignSendPreview(campaign?.id, {
    enabled: Boolean(campaign?.id),
  });

  if (!selection || !campaign) return null;

  const audience = summarizeSendPreview(preview.data).deliverable;
  const view = activeSendView({
    ...(campaign.name === undefined ? {} : { name: campaign.name }),
    ...(campaign.subject === undefined ? {} : { subject: campaign.subject }),
    others: selection.others,
    sent: report.data?.sent ?? null,
    audience,
    openRate: campaign.open_rate ?? null,
    clickRate: campaign.click_rate ?? null,
    // A failed read is an error state, never "nothing has sent yet".
    unavailable: report.isError,
  });

  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        router.push({
          pathname: "/(tabs)/campaigns/[id]",
          params: { id: String(campaign.id) },
        });
      }}
      accessibilityRole="button"
      accessibilityLabel={view.spoken}
      // The numbers change underneath a stationary reader; announce the change
      // rather than making them re-focus the element to hear it.
      accessibilityLiveRegion="polite"
      android_ripple={{ color: t.borderSubtle }}
      // NativeWind v4: a function-style `style` on a Pressable silently drops
      // layout. Static object only.
      style={{
        backgroundColor: t.surface,
        borderColor: t.warning,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 12,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pill label={msg("dashboard.activeSend.label")} tone="warning" />
        <View style={{ flex: 1 }} />
        {view.others ? (
          <Text
            {...typeCap("badgeSmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("badgeSmall"),
              fontFamily: FONT.medium,
            }}
            numberOfLines={1}
          >
            {view.others}
          </Text>
        ) : null}
      </View>

      <Text
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
        numberOfLines={1}
        // The composed label on the Pressable already reads all of this;
        // letting VoiceOver reach the fragments too repeats every number.
        importantForAccessibility="no-hide-descendants"
      >
        {view.title}
      </Text>

      {view.fraction === null ? null : (
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
              width: `${Math.round(view.fraction * 100)}%`,
              height: 6,
              backgroundColor: t.warning,
            }}
          />
        </View>
      )}

      <Text
        {...typeCap("numeric")}
        style={{
          color: t.fgMuted,
          ...typeStyle("numeric"),
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
        numberOfLines={1}
        importantForAccessibility="no-hide-descendants"
      >
        {view.progress}
      </Text>

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
        numberOfLines={1}
        importantForAccessibility="no-hide-descendants"
      >
        {view.rates}
      </Text>
    </Pressable>
  );
}
