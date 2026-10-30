/**
 * AudienceMixSection — "where do opens come from, and what got clicked",
 * across recent sends rather than one campaign at a time.
 *
 * Desktop's three audience panels (AnalyticsAudiencePanels.tsx: MailClientPanel,
 * GeographyPanel, TopLinksPanel) sum the per-campaign `/devices`, `/geography`
 * and `/link-report` reads over its five most recent campaigns. The phone had
 * every one of those endpoints wired — but only behind a single campaign's
 * report, so answering "which mail clients does my audience use?" meant opening
 * campaigns one by one and adding up in your head.
 *
 * ARMED BY A PRESS, and the queries live in a child component that only mounts
 * once armed. Fifteen aggregate queries is not a cost to pay because someone
 * scrolled past a heading — and mounting the hook unconditionally would fire
 * the campaigns list read even while collapsed.
 *
 * The scope sentence is not decoration: these totals are the RECENT SENT
 * campaigns, not the reporting window at the top of the screen (no per-campaign
 * endpoint takes a date range), and a partial rollup names the reads it could
 * not include. A chart that quietly drops a fifth of the opens is worse than
 * one that says which fifth is missing.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { InsightRankedList } from "@/components/campaigns/CampaignInsightCard";
import { ErrorState } from "@/components/ErrorState";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonCard } from "@/components/Skeleton";
import { useAudienceMix } from "@/hooks/useAudienceMix";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  AUDIENCE_MIX_EMPTY,
  AUDIENCE_MIX_OFFLINE,
  AUDIENCE_MIX_SUBTITLE,
  audienceMixPanelUnavailable,
  audienceMixScopeCaption,
  type AudienceMixRead,
} from "@/lib/audienceMix";
import { linkRows, namedOpenRows } from "@/lib/campaignInsights";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const TITLE = "Audience mix";

function Caption({ text, alert }: { text: string; alert?: boolean }) {
  const { t } = useTheme();
  if (!text) return null;
  return (
    <Text
      {...(alert ? { accessibilityRole: "alert" as const } : {})}
      {...typeCap("caption")}
      style={{
        color: alert ? t.warning : t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
        marginTop: 6,
      }}
    >
      {text}
    </Text>
  );
}

/**
 * `emptyText` is a parameter rather than a constant because the two empty
 * states are DIFFERENT CLAIMS: "nothing was recorded" is about the workspace,
 * "we couldn't read it" is about the request, and a failed read that borrows
 * the first sentence tells the reader their audience is silent.
 */
function Panel({
  title,
  rows,
  emptyText,
  t,
}: {
  title: string;
  rows: ReturnType<typeof namedOpenRows>;
  emptyText: string;
  t: ThemeTokens;
}) {
  return (
    <View
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: t.border,
        padding: 14,
        marginTop: 10,
        gap: 10,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.semibold,
        }}
      >
        {title}
      </Text>
      {rows.length === 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {emptyText}
        </Text>
      ) : (
        <InsightRankedList rows={rows} />
      )}
    </View>
  );
}

function AudienceMixPanels() {
  const { t } = useTheme();
  const mix = useAudienceMix();

  if (mix.loading) return <SkeletonCard />;

  if (mix.listError) {
    return (
      <ErrorState error={mix.listError} onRetry={mix.refetch} compact />
    );
  }

  if (mix.campaignsUsed === 0) {
    return <Caption text={audienceMixScopeCaption(0, mix.campaignsListed)} />;
  }

  if (mix.error || !mix.view) {
    return <ErrorState error={mix.error} onRetry={mix.refetch} compact />;
  }

  const view = mix.view;
  const shows = (read: AudienceMixRead) => !view.absent.includes(read);
  // A panel with no rows AND a failed read is a request that did not land, not
  // an audience that did nothing.
  const emptyFor = (read: AudienceMixRead) =>
    view.failedReads.includes(read)
      ? audienceMixPanelUnavailable(read)
      : AUDIENCE_MIX_EMPTY;

  return (
    <View>
      <Caption
        text={audienceMixScopeCaption(mix.campaignsUsed, mix.campaignsListed)}
      />
      <Caption text={view.missing} alert />
      {shows("devices") ? (
        <Panel
          title="Mail clients"
          rows={namedOpenRows(view.devices, "client")}
          emptyText={emptyFor("devices")}
          t={t}
        />
      ) : null}
      {shows("geography") ? (
        <Panel
          title="Top countries"
          rows={namedOpenRows(view.geography, "country")}
          emptyText={emptyFor("geography")}
          t={t}
        />
      ) : null}
      {shows("links") ? (
        <Panel
          title="Top links"
          rows={linkRows(view.links)}
          emptyText={emptyFor("links")}
          t={t}
        />
      ) : null}
    </View>
  );
}

export function AudienceMixSection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const [armed, setArmed] = useState(false);
  // Checked HERE, not inside the panels: with nothing cached, an offline
  // rollup reaches the zero-campaigns branch and prints "No sent campaigns in
  // the recent list." — a statement about the workspace made from a phone that
  // never got to ask.
  const offline = !gate.enabled;

  return (
    <View style={{ marginTop: 24 }}>
      <SectionLabel subtitle={AUDIENCE_MIX_SUBTITLE}>{TITLE}</SectionLabel>
      {offline ? (
        <Caption text={AUDIENCE_MIX_OFFLINE} />
      ) : armed ? (
        <AudienceMixPanels />
      ) : (
        <Pressable
          onPress={() => {
            haptics.tap();
            setArmed(true);
          }}
          accessibilityRole="button"
          accessibilityLabel="Show the audience mix across recent sent campaigns"
          accessibilityHint="Reads mail clients, countries and links for each recent send."
          hitSlop={8}
          style={{
            minHeight: 44,
            justifyContent: "center",
            borderRadius: 12,
            borderWidth: 1,
            borderColor: t.border,
            paddingHorizontal: 14,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            Show audience mix
          </Text>
        </Pressable>
      )}
    </View>
  );
}
