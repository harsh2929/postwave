/**
 * RecentCampaignsCard — the dashboard's "Recent campaigns" block.
 *
 * Extracted from the screen so the four states it has to distinguish live
 * somewhere they can be read in one go:
 *
 *  - A FAILED REFRESH OVER ROWS WE ALREADY HAVE keeps the rows and adds a
 *    staleness banner. Replacing readable content with an error card destroys
 *    good information over one bad poll.
 *  - A CLOSED ONLINE GATE WITH NOTHING CACHED explains itself rather than
 *    rendering "No campaigns yet", which would claim the workspace is empty
 *    when the truth is that this device cannot ask.
 *  - LOADING / EMPTY / ERROR-WITH-NOTHING go through the shared five-state
 *    ladder.
 *  - TRUNCATION IS DISCLOSED. The list query fetches ten rows and the card
 *    shows five, so a workspace with four hundred campaigns and one with
 *    exactly five used to render identically. The rest of the page it already
 *    paid for is one tap away, and "See all" carries everything beyond it.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import {
  CachedSessionNotice,
  type CachedSessionNoticeContent,
} from "@/components/CachedSessionNotice";
import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SkeletonList } from "@/components/Skeleton";
import { StaleDataBanner } from "@/components/StaleDataBanner";
import { RecentCampaignRow } from "@/components/dashboard/RecentCampaignRow";
import type { Campaign } from "@/hooks/useCampaigns";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { plural } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Rows shown before the reader asks for more. */
export const RECENT_CAMPAIGN_ROWS = 5;

export interface RecentCampaignsCardProps {
  query: QueryLike & { refetch: () => unknown };
  campaigns: readonly Campaign[];
  gate: Pick<OnlineQueryGate, "enabled">;
  /** Non-null when the session is cached-only; carries its own explanation. */
  gateNotice: CachedSessionNoticeContent | null;
}

export function RecentCampaignsCard({
  query,
  campaigns,
  gate,
  gateNotice,
}: RecentCampaignsCardProps) {
  const { t } = useTheme();
  const [expanded, setExpanded] = useState(false);

  const visible = expanded ? campaigns : campaigns.slice(0, RECENT_CAMPAIGN_ROWS);
  const hidden = campaigns.length - visible.length;

  const rows = (
    <>
      {visible.map((campaign) => (
        <RecentCampaignRow key={String(campaign.id)} campaign={campaign} />
      ))}
      {hidden > 0 || expanded ? (
        <Pressable
          onPress={() => {
            haptics.tap();
            setExpanded((open) => !open);
          }}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={
            expanded
              ? `Show only the ${RECENT_CAMPAIGN_ROWS} most recent campaigns`
              : `Show ${plural(hidden, "more recent campaign")} already loaded. More beyond these are on the campaigns screen.`
          }
          // NativeWind v4: static style object only — a function-style `style`
          // on a Pressable silently drops layout.
          style={{
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 10,
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
            {expanded ? "Show fewer" : `Show ${hidden} more`}
          </Text>
        </Pressable>
      ) : null}
    </>
  );

  if (query.isError && visible.length > 0) {
    return (
      <>
        <StaleDataBanner onRetry={() => void query.refetch()} />
        {rows}
      </>
    );
  }

  if (gateNotice && campaigns.length === 0) {
    return <CachedSessionNotice notice={gateNotice} />;
  }

  return (
    <QueryStates
      query={query}
      isEmpty={campaigns.length === 0}
      gate={gate}
      skeleton={<SkeletonList rows={3} lines={2} />}
      empty={{
        title: "No campaigns yet",
        description: "Drafts authored on the web show up here. Pull to refresh.",
      }}
    >
      <View>{rows}</View>
    </QueryStates>
  );
}
