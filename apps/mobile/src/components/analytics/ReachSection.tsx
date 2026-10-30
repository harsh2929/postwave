/**
 * ReachSection — how many recipients we can actually defend as people.
 *
 * The three deliverability tiles on this screen count opens and clicks, and
 * both count machines: image proxies, prefetchers and security scanners all
 * generate them. This section is the honest version of that question, and it
 * sits below them for exactly that reason — it reframes the numbers already on
 * screen rather than adding another one to scan past.
 *
 * It is a FLOOR, never an estimate. The band of unclassified recipients is
 * rendered at the same weight as the floor, because a lower bound quoted
 * without its band stops being a lower bound. The server sends the sentence
 * itself so no client can show the number alone; this renders that sentence.
 *
 * Caveats sit ABOVE the figure. A caveat printed underneath is read after the
 * number has already been believed — and on a phone it is often below the fold.
 */
import { Text, View } from "react-native";

import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonCard } from "@/components/Skeleton";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import {
  reachCaveats,
  reachHeadline,
  REACH_UNAVAILABLE_MESSAGE,
  type HumanEngagedReach,
} from "@/lib/humanEngagedReach";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ReachSectionProps {
  reach: HumanEngagedReach | undefined;
  loading: boolean;
  error?: unknown;
}

export function ReachSection({ reach, loading, error }: ReachSectionProps) {
  const { t } = useTheme();

  if (loading) {
    return (
      <View style={{ marginTop: 24 }}>
        <SectionLabel>Human-engaged reach</SectionLabel>
        <SkeletonCard />
      </View>
    );
  }

  if (!reach) {
    const message =
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string" &&
      error.message.trim() !== ""
        ? error.message
        : REACH_UNAVAILABLE_MESSAGE;
    return (
      <View style={{ marginTop: 24 }}>
        <SectionLabel>Human-engaged reach</SectionLabel>
        <View
          accessibilityRole="alert"
          style={{
            marginTop: 8,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.warning,
            padding: 10,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{ color: t.fg, ...typeStyle("bodySmall") }}
          >
            {message} This is not a reading of zero engagement; no released
            measurement was made.
          </Text>
        </View>
      </View>
    );
  }

  const caveats = reachCaveats(reach);
  const share =
    reach.provider_accepted_recipients > 0
      ? (reach.human_engaged_reach_floor / reach.provider_accepted_recipients) *
        100
      : undefined;

  return (
    <View style={{ marginTop: 24 }}>
      <SectionLabel>Human-engaged reach</SectionLabel>

      {caveats.map((caveat) => (
        <View
          key={caveat}
          style={{
            marginTop: 8,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.warning,
            padding: 10,
          }}
        >
          <Text
            accessibilityRole="text"
            {...typeCap("bodySmall")}
            style={{ color: t.fg, ...typeStyle("bodySmall") }}
          >
            {caveat}
          </Text>
        </View>
      ))}

      <View
        style={{
          marginTop: 8,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          padding: 14,
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
          }}
        >
          {reachHeadline(reach)}
        </Text>
        {share === undefined ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              marginTop: 4,
            }}
          >
            Nothing was delivered in this window.
          </Text>
        ) : (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              marginTop: 4,
            }}
          >
            {share.toFixed(1)}% of {num(reach.provider_accepted_recipients)}{" "}
            accepted recipients.
          </Text>
        )}

        <View style={{ marginTop: 12, gap: 6 }}>
          <ReachRow
            label="Human-classified signal"
            value={reach.human_engaged_reach_floor}
          />
          <ReachRow label="Unclassified" value={reach.unknown_band} />
          <ReachRow
            label="Machine only"
            value={reach.machine_only_recipients}
          />
          {/* Shown, not folded away: it is usually the largest group, and
              hiding it makes the other three look like the whole population. */}
          <ReachRow
            label="No interaction"
            value={reach.no_interaction_recipients}
            muted
          />
        </View>

        <Text
          {...typeCap("caption")}
          style={{ color: t.fgMuted, ...typeStyle("caption"), marginTop: 12 }}
        >
          {reach.methodology}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{ color: t.fgMuted, ...typeStyle("caption"), marginTop: 4 }}
        >
          classifier {reach.classifier_version} · methodology{" "}
          {reach.methodology_version}
        </Text>
      </View>
    </View>
  );
}

function ReachRow({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: number;
  muted?: boolean;
}) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      <Text
        {...typeCap("bodySmall")}
        style={{ color: muted ? t.fgMuted : t.fg, ...typeStyle("bodySmall") }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: muted ? t.fgMuted : t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
        }}
      >
        {num(value)}
      </Text>
    </View>
  );
}
