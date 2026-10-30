/**
 * SpamTrapGuardCard — the STANDING spam-trap evidence beside the run-now
 * sweep verb the phone already had.
 *
 * Mobile could trigger a sweep (ReputationResponseCard) but could never see
 * what the guard has actually caught: hits in the last 30 days, how many
 * subscribers are blocklisted, and the addresses still eligible for
 * containment. A sweep verb with no evidence readout is a lever with no
 * gauge — the operator pulls it and learns nothing.
 */
import { Text, View } from "react-native";

import {
  OpsCard,
  OpsCardBody,
  OpsCardTitle,
} from "@/components/deliverability/OpsCard";
import { Pill } from "@/components/Pill";
import {
  useSpamTrapHits,
  useSpamTrapStats,
} from "@/hooks/useDeliverabilityRecovery";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { num, plural, relativeTime } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const SHOWN_HITS = 5;

export function SpamTrapGuardCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const stats = useSpamTrapStats();
  const hits = useSpamTrapHits(30);
  const offline = !gate.enabled;

  const summary = offline
    ? "Spam-trap evidence can't be read offline."
    : stats.isError
      ? "Spam-trap stats couldn't be loaded — the guard's real state is unknown."
      : !stats.data
        ? "Loading spam-trap stats…"
        : stats.data.hitsLast30Days === 0
          ? "No spam-trap hits in the last 30 days."
          : `${plural(stats.data.hitsLast30Days, "trap hit")} in 30 days · ${num(stats.data.blocklistedCount)} blocklisted · ${num(stats.data.eligibleNow)} still eligible for containment.`;

  const rows = Array.isArray(hits.data) ? hits.data.slice(0, SHOWN_HITS) : [];

  return (
    <OpsCard>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <OpsCardTitle>Spam-trap guard</OpsCardTitle>
        {stats.data && stats.data.hitsLast30Days > 0 && !offline ? (
          <Pill label="hits" tone="danger" />
        ) : null}
      </View>
      <OpsCardBody {...(stats.isError ? { role: "alert" as const } : {})}>
        {summary}
      </OpsCardBody>
      {!offline && hits.isError ? (
        <OpsCardBody role="alert">
          The hit list couldn&apos;t be loaded — the counts above may not be the
          whole story.
        </OpsCardBody>
      ) : null}
      {rows.map((hit) => (
        <View
          key={hit.email}
          accessible
          accessibilityLabel={`${hit.email}, ${plural(hit.hitCount, "hit")}, latest ${relativeTime(hit.lastHitAt)}${hit.status ? `, subscriber ${hit.status}` : ""}`}
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 8,
            gap: 2,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.medium,
            }}
            numberOfLines={1}
          >
            {hit.email}
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {`${plural(hit.hitCount, "hit")} · latest ${relativeTime(hit.lastHitAt)}${hit.status ? ` · ${hit.status}` : ""}`}
          </Text>
        </View>
      ))}
      {Array.isArray(hits.data) && hits.data.length > SHOWN_HITS ? (
        <OpsCardBody>
          {`Showing the newest ${SHOWN_HITS} of ${num(hits.data.length)} trapped addresses.`}
        </OpsCardBody>
      ) : null}
    </OpsCard>
  );
}
