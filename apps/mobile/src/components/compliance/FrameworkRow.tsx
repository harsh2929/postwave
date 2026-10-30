/**
 * FrameworkRow — one compliance framework, at a glance.
 *
 * WHAT LEADS. The framework's short name and its STATE, in that order: a
 * compliance owner scanning this list is looking for the one red word, and
 * everything else on the row exists to tell them whether it is worth opening.
 *
 * WHAT IS DELIBERATELY NOT A DATE. `renewal_at` is nullable (migration 0193
 * line 35) and three supported frameworks have no renewal by nature, so a row
 * with no date shows an em-dash and the state pill carries the reason. A date
 * synthesised from the framework's usual cadence would be a deadline nobody
 * set.
 *
 * State is never colour alone: the state is a labelled Pill AND the row's
 * spoken label starts with the same word.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill, type PillTone } from "@/components/Pill";
import {
  postureRowSpokenLabel,
  postureStateLabel,
  postureStateTone,
} from "@/lib/complianceLabels";
import type { ProgramPosture } from "@/lib/compliancePosture";
import { EMDASH, date } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface FrameworkRowProps {
  row: ProgramPosture;
  selected: boolean;
  onSelect: (framework: string) => void;
}

export function FrameworkRow({ row, selected, onSelect }: FrameworkRowProps) {
  const { t } = useTheme();
  const stateLabel = postureStateLabel(row.state);
  const tone = postureStateTone(row.state) as PillTone;
  const renewal = row.program.renewalAt ? date(row.program.renewalAt) : EMDASH;
  const secondary =
    row.state === "unsupported"
      ? row.meta.region
      : [row.meta.region, renewal === EMDASH ? "no renewal date" : `renews ${renewal}`]
          .filter(Boolean)
          .join(" · ");

  return (
    <Pressable
      onPress={() => onSelect(row.program.framework)}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={postureRowSpokenLabel(row, renewal, selected)}
      style={{
        backgroundColor: t.surface,
        borderColor: selected ? t.accent : t.borderSubtle,
        borderWidth: selected ? 2 : 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
        minHeight: 44,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
            numberOfLines={1}
          >
            {row.meta.short}
          </Text>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              marginTop: 2,
              fontFamily: FONT.regular,
            }}
            numberOfLines={1}
          >
            {secondary}
          </Text>
        </View>
        <Pill label={stateLabel} tone={tone} />
      </View>
    </Pressable>
  );
}
