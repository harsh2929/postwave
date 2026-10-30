/**
 * IncidentRow — one breach incident, led by its clock.
 *
 * THE CLOCK COMES FIRST, VISUALLY AND IN THE SPOKEN LABEL. Severity is what an
 * incident IS; the countdown is what it needs. A register sorted and read by
 * severity lets a "medium" incident with four hours left sit under a "high"
 * with two days, which is the exact mistake this screen exists to prevent.
 *
 * NO COLOUR-ONLY STATE. The clock badge carries a word ("9h left", "6h over"),
 * the severity badge carries a word, and the row's single accessibility label
 * spells all of it out — the tint is reinforcement, never the message.
 *
 * ONE ACCESSIBILITY STOP, NOT SIX. Ungrouped, VoiceOver reads a row as
 * "Critical", "Open", "9h left", then the summary, then the date, with no
 * relationship between them. Grouped, it is one button that says what the
 * incident is, where it is, and how long is left.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { dateTime, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import {
  incidentSeverityBadge,
  incidentStateBadge,
} from "@/lib/privacyIncidentCopy";
import { incidentClock } from "@/lib/privacyIncidentPolicy";
import type { PrivacyIncident } from "@/lib/privacyIncidents";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface IncidentRowProps {
  incident: PrivacyIncident;
  onPress: (incident: PrivacyIncident) => void;
  now: number;
}

export function IncidentRow({ incident, onPress, now }: IncidentRowProps) {
  const { t } = useTheme();
  const clock = incidentClock(incident, now);
  const severity = incidentSeverityBadge(incident);
  const state = incidentStateBadge(incident);
  const detected = incident.detectedAt
    ? `Detected ${relativeTime(incident.detectedAt, { now })}`
    : "Detection time not recorded";

  const spoken = [
    severity.spoken,
    state.spoken,
    clock.spoken,
    incident.summary || "No summary recorded",
    detected,
  ].join(". ");

  return (
    <Pressable
      onPress={() => onPress(incident)}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint="Opens the incident, jurisdiction guidance status and activity ledger"
      style={{
        backgroundColor: t.surface,
        borderColor: clock.state === "overdue" ? t.danger : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        minHeight: 44,
        gap: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <Pill
          label={clock.label}
          tone={clock.tone}
          size="md"
          accessibilityLabel={clock.spoken}
        />
        <Pill
          label={severity.label}
          tone={severity.tone}
          accessibilityLabel={severity.spoken}
        />
        <Pill
          label={state.label}
          tone={state.tone}
          accessibilityLabel={state.spoken}
        />
      </View>

      <Text
        numberOfLines={2}
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          fontFamily: FONT.semibold,
        }}
      >
        {incident.summary || "No summary recorded"}
      </Text>

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {detected}
        {incident.detectedAt ? ` · ${dateTime(incident.detectedAt)}` : ""}
      </Text>
    </Pressable>
  );
}
