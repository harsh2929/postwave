/**
 * GoalsCard — "are we going to hit the number?", on a phone.
 *
 * Renders nothing when the workspace has set no targets. An empty "no goals
 * yet" card would occupy the dashboard's most valuable space every day to
 * report an absence, and the place to CREATE a goal is not here — POST
 * /api/v1/goals needs the admin scope and a period contract, which is desk
 * work. The card says that once, at the bottom, instead of showing a dead
 * "Add goal" button.
 *
 * Three things each row must carry, because a progress bar alone is a claim
 * without evidence:
 *
 *  - THE PACE VERDICT IS A WORD, NOT A COLOUR. "Behind pace" survives
 *    greyscale and colour-blindness; a red bar does not.
 *  - THE BAR IS CLAMPED, THE NUMBER IS NOT. A workspace at 140% of target
 *    sees a full bar AND "140%" — clamping the figure would hide the win.
 *  - THE UNIT IS THE METRIC'S OWN. Open rate is a percentage, revenue is
 *    money in the window's dominant currency, subscribers are a count.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { SectionLabel } from "@/components/SectionLabel";
import { Skeleton } from "@/components/Skeleton";
import { FONT } from "@/lib/fonts";
import { percent, relativeTime } from "@/lib/format";
import { formatGoalPosition } from "@/lib/goalsFormat";
import {
  goalBarFraction,
  goalPaceLabel,
  type GoalPace,
  type GoalProgress,
} from "@/lib/goals";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface GoalsCardProps {
  goals: readonly GoalProgress[];
  loading: boolean;
  /** Cap the rows so a workspace with twenty targets does not own the screen. */
  limit?: number;
  /** Injected so the relative "ends in 12 days" is testable and tick-driven. */
  now?: number;
}

function paceTone(pace: GoalPace): "success" | "warning" | "neutral" {
  switch (pace) {
    case "ahead":
      return "success";
    case "behind":
      return "warning";
    case "on_track":
      return "neutral";
  }
}

export function GoalsCard({ goals, loading, limit = 4, now }: GoalsCardProps) {
  const { t } = useTheme();
  if (loading) {
    return (
      <View>
        <SectionLabel>Goals</SectionLabel>
        <View
          style={{
            backgroundColor: t.surface,
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 14,
            padding: 14,
            gap: 10,
          }}
        >
          <Skeleton width="60%" height={14} radius={6} />
          <Skeleton width="90%" height={10} radius={6} />
        </View>
      </View>
    );
  }
  // Array.isArray, not `.length === 0`: on a truthy non-array `{}` the length
  // check is falsy and execution falls through to the iteration below, which
  // throws and takes the dashboard down. The caller passes `q.data ?? []`, a
  // NULLISH guard that does not catch it; reachable from a restored persisted
  // cache written by an older response shape.
  const list = Array.isArray(goals) ? goals : [];
  if (list.length === 0) return null;

  const rows = list.slice(0, limit);
  return (
    <View>
      <SectionLabel>Goals</SectionLabel>
      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        {rows.map((goal, index) => (
          <GoalRow
            key={goal.id}
            goal={goal}
            first={index === 0}
            {...(now === undefined ? {} : { now })}
          />
        ))}
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            paddingHorizontal: 14,
            paddingBottom: 12,
            paddingTop: 2,
          }}
        >
          Targets are set on the desktop, where the period and metric contract
          lives.
        </Text>
      </View>
    </View>
  );
}

function GoalRow({
  goal,
  first,
  now,
}: {
  goal: GoalProgress;
  first: boolean;
  now?: number;
}) {
  const { t } = useTheme();
  const fraction = goalBarFraction(goal.pct);
  const position = formatGoalPosition(goal.metric, goal.current, goal.target);
  const pctLabel = percent(goal.pct, { digits: 0 });
  const pace = goalPaceLabel(goal.pace);
  const endsIn = goal.periodEnd
    ? relativeTime(goal.periodEnd, now === undefined ? undefined : { now })
    : null;

  return (
    <View
      accessible
      // One stop per goal, and it opens with the verdict: an operator
      // swiping through five goals needs "behind" before "812 of 1,000".
      accessibilityLabel={`${goal.name}. ${pace}. ${pctLabel} of target, ${position}.${
        endsIn ? ` Period ends ${endsIn}.` : ""
      }`}
      style={{
        gap: 8,
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: t.borderSubtle,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("body")}
          numberOfLines={1}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
        >
          {goal.name}
        </Text>
        <Pill label={pace} tone={paceTone(goal.pace)} />
      </View>

      {/* Track + fill. `accessibilityElementsHidden` is unnecessary: the row
          above is `accessible`, so VoiceOver reads it as one element. */}
      <View
        style={{
          height: 6,
          borderRadius: 999,
          backgroundColor: t.borderSubtle,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            width: `${Math.round(fraction * 100)}%`,
            height: "100%",
            backgroundColor: goal.pace === "behind" ? t.warning : t.accent,
          }}
        />
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("numeric")}
          style={{
            color: t.fgMuted,
            ...typeStyle("numeric"),
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
            flexShrink: 1,
          }}
        >
          {/* Not clamped: a workspace at 140% of target has earned the number. */}
          {pctLabel} · {position}
        </Text>
        {endsIn ? (
          <Text
            // Same dense step as its row-mate: these two share one line and
            // the ink already carries the hierarchy between them.
            {...typeCap("numeric")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("numeric"),
              fontFamily: FONT.regular,
            }}
          >
            ends {endsIn}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
