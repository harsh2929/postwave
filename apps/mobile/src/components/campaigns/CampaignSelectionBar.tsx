/**
 * CampaignSelectionBar — the bottom bar that appears once rows are selected.
 *
 * Desktop puts bulk actions in a toolbar above a table with a header
 * checkbox. A phone has neither, so selection is entered with a LONG PRESS on
 * a row and left with Done — the iOS convention — and the verbs live in a bar
 * pinned above the tab bar, inside thumb reach.
 *
 * Four rules this bar follows that a greyed-out toolbar does not:
 *
 *  - EVERY DISABLED VERB SAYS WHY. `blockedReason` is rendered as a sentence
 *    above the buttons, not implied by opacity. A control that is dim for an
 *    unstated reason is the single most common complaint in this app's audits.
 *  - PROGRESS IS VISIBLE. Bulk delete and move are sequential per-campaign
 *    round trips, so the bar counts them off ("Deleting 3 of 12…") rather than
 *    freezing behind one spinner.
 *  - NOTHING IS COLOUR-ONLY. Delete carries the word "Delete" and the danger
 *    tone; the count is spoken in full in the bar's accessibility label.
 *  - THE COUNT IS THE TITLE. "3 selected" is the first thing VoiceOver reads,
 *    because the number is the state the verbs act on.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useTheme, type ThemeTokens } from "@/lib/theme";

export interface SelectionVerb {
  key: string;
  label: string;
  onPress: () => void;
  /** Null when available; a full sentence when not. */
  blockedReason: string | null;
  destructive?: boolean;
}

export interface CampaignSelectionBarProps {
  count: number;
  verbs: readonly SelectionVerb[];
  onDone: () => void;
  /** e.g. "Deleting 3 of 12…" — shown in place of the verbs while running. */
  busyLabel: string | null;
}

function VerbButton({
  verb,
  t,
  disabled,
}: {
  verb: SelectionVerb;
  t: ThemeTokens;
  disabled: boolean;
}) {
  const blocked = verb.blockedReason !== null || disabled;
  return (
    <Pressable
      onPress={blocked ? undefined : verb.onPress}
      accessibilityRole="button"
      accessibilityLabel={verb.label}
      accessibilityState={{ disabled: blocked }}
      {...(verb.blockedReason ? { accessibilityHint: verb.blockedReason } : {})}
      disabled={blocked}
      style={{
        minHeight: 44,
        justifyContent: "center",
        paddingHorizontal: 14,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: verb.destructive ? t.danger : t.border,
        backgroundColor: t.surface,
        opacity: blocked ? 0.45 : 1,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: verb.destructive ? t.danger : t.fg,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        {verb.label}
      </Text>
    </Pressable>
  );
}

export function CampaignSelectionBar({
  count,
  verbs,
  onDone,
  busyLabel,
}: CampaignSelectionBarProps) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  // Only reasons for verbs the operator could otherwise reach; a list of five
  // sentences would be noise, so the first one carries the message.
  const reason = verbs.find((v) => v.blockedReason !== null)?.blockedReason;

  return (
    <View
      accessibilityLabel={`${plural(count, "campaign")} selected`}
      style={{
        borderTopColor: t.border,
        borderTopWidth: 1,
        backgroundColor: t.surface,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: Math.max(insets.bottom, 10),
        gap: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          {...typeCap("label")}
          accessibilityRole="header"
          style={{
            color: t.fg,
            ...typeStyle("label"),
            fontFamily: FONT.semibold,
            fontVariant: ["tabular-nums"],
          }}
        >
          {busyLabel ?? `${count} selected`}
        </Text>
        <Pressable
          onPress={onDone}
          accessibilityRole="button"
          accessibilityLabel="Leave selection mode"
          hitSlop={8}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.accent,
              ...typeStyle("label"),
              fontFamily: FONT.semibold,
            }}
          >
            Done
          </Text>
        </Pressable>
      </View>

      {busyLabel ? null : (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {verbs.map((verb) => (
            <VerbButton
              key={verb.key}
              verb={verb}
              t={t}
              disabled={busyLabel !== null}
            />
          ))}
        </View>
      )}

      {!busyLabel && reason ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {reason}
        </Text>
      ) : null}
    </View>
  );
}
