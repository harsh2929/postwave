/**
 * SequenceRow — one row of the sequences index.
 *
 * Extracted from the screen so the row can carry a SWIPE ACTION without
 * pushing `sequences/index.tsx` past its source budget, and so the delete
 * gating is written once.
 *
 * Why SwipeableRow rather than a bespoke gesture: it publishes every action as
 * an `accessibilityAction` as well, so the gesture is never the only path to
 * the feature. A swipe has no visible affordance and VoiceOver users cannot
 * perform one at all — adding a swipe without the rotor action makes the app
 * less accessible, not more.
 *
 * The list payload carries NO version, and the server requires If-Match on a
 * delete, so the flow resolves the version with a GET first
 * (hooks/useSequences.useDeleteSequence). Optimistic concurrency is preserved,
 * not bypassed: a row that moved in between answers 412 and says so.
 */
import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { SwipeableRow, type SwipeAction } from "@/components/SwipeableRow";
import { useSequenceDeleteFlow } from "@/components/sequences/SequenceDeleteAction";
import { FONT } from "@/lib/fonts";
import { plural, relativeTime } from "@/lib/format";
import { mobileSequenceStatusPresentation } from "@/lib/sequenceCapabilities";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import type { SequenceListItem } from "@/api/sequences";

export function SequenceRow({
  item,
  stepCount,
  canDelete,
}: {
  item: SequenceListItem;
  stepCount: number;
  /** False offline or without write access — the action is then absent, not
   *  disabled, so the gesture never reveals a button that cannot work. */
  canDelete: boolean;
}) {
  const { t } = useTheme();
  const { run } = useSequenceDeleteFlow();
  const id = item.id;
  const name = item.name ?? "Untitled sequence";
  const updated = item.updated_at ? relativeTime(item.updated_at) : null;
  const presentedStatus = mobileSequenceStatusPresentation(item.status);
  const label = `Open sequence ${name}. ${presentedStatus.label}. ${plural(stepCount, "step")}${updated ? `. Updated ${updated}` : ""}`;

  const actions: SwipeAction[] = canDelete
    ? [
        {
          label: "Delete",
          kind: "danger",
          onPress: () => {
            void run({ id: String(id ?? ""), name, stepCount });
          },
        },
      ]
    : [];

  return (
    <SwipeableRow right={actions} accessibilityLabel={label}>
      <Link
        href={{
          pathname: "/(tabs)/sequences/[id]",
          params: { id: String(id ?? "") },
        }}
        asChild
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          style={{
            backgroundColor: t.surface,
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 14,
            padding: 14,
            minHeight: 64,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
                flex: 1,
              }}
              numberOfLines={2}
            >
              {name}
            </Text>
            <Pill label={presentedStatus.label} tone={presentedStatus.tone} />
          </View>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              marginTop: 8,
              gap: 12,
            }}
          >
            <Text
              {...typeCap("numeric")}
              style={{
                color: t.fgMuted,
                ...typeStyle("numeric"),
                fontFamily: FONT.regular,
              }}
            >
              {plural(stepCount, "step")}
            </Text>
            {updated ? (
              <Text
                {...typeCap("numeric")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("numeric"),
                  fontFamily: FONT.regular,
                  flexShrink: 1,
                }}
                numberOfLines={1}
              >
                Updated {updated}
              </Text>
            ) : null}
          </View>
        </Pressable>
      </Link>
    </SwipeableRow>
  );
}
