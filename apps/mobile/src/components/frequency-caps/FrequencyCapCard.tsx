/**
 * One frequency-cap rule: what it does, whether it is enforcing, and — for a
 * session that may PATCH — the toggle.
 *
 * The state is carried in WORDS ("Enforcing" / "Off"), not only in the switch's
 * colour, because the whole point of the row is a yes/no that must survive
 * colour blindness and a glance in sunlight.
 *
 * NativeWind v4: static style objects only — `style={({pressed}) => ...}`
 * silently drops layout.
 */
import { Switch, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import {
  capRuleLine,
  capScopeLine,
  type FrequencyCap,
} from "@/lib/frequencyCaps";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface FrequencyCapCardProps {
  cap: FrequencyCap;
  /** Null when this session's role cannot PATCH — the switch is then absent. */
  onToggle: ((cap: FrequencyCap, next: boolean) => void) | null;
  busy: boolean;
}

export function FrequencyCapCard({
  cap,
  onToggle,
  busy,
}: FrequencyCapCardProps) {
  const { t } = useTheme();
  const state = cap.active ? "Enforcing" : "Off";
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: cap.active ? t.border : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        marginHorizontal: 16,
        marginTop: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {cap.label}
        </Text>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            marginTop: 2,
            fontFamily: FONT.regular,
          }}
        >
          {capRuleLine(cap)}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 2,
            fontFamily: FONT.regular,
          }}
        >
          {capScopeLine(cap)}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: cap.active ? t.success : t.fgMuted,
            ...typeStyle("caption"),
            marginTop: 4,
            fontWeight: "700",
            fontFamily: FONT.bold,
          }}
        >
          {state}
        </Text>
      </View>
      {onToggle ? (
        <Switch
          value={cap.active}
          disabled={busy}
          onValueChange={(next) => onToggle(cap, next)}
          accessibilityLabel={`${cap.label}, ${capRuleLine(cap)}. Currently ${state.toLowerCase()}.`}
          accessibilityHint={
            cap.active
              ? "Turns this cap off so it stops deferring messages"
              : "Turns this cap on so it starts deferring messages"
          }
          accessibilityState={{ disabled: busy, busy }}
          trackColor={{ false: t.borderSubtle, true: t.accentSubtle }}
          thumbColor={cap.active ? t.accent : t.fgMuted}
        />
      ) : null}
    </View>
  );
}
