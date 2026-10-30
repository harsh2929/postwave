/**
 * AudienceSyncSummary — where this audience comes from, where it goes, and when
 * it is next expected to go there.
 *
 * Split out of AudienceSyncDetailSheet when that file crossed its 450-line
 * ceiling. The seam is real rather than arbitrary: the sheet owns the VERB and
 * the run history, this owns the standing description of the connection. Both
 * are read-only — nothing on this surface edits a sync.
 *
 * THE SIGNING KEY IS DESCRIBED, NEVER HELD. Reads substitute `secret_set` plus
 * a masked tail for the HMAC secret (`scanSync`, syncs.go:337-338), and the
 * secret itself is never on the wire. So this states the FACT of a signing key,
 * and states its ABSENCE loudly, without ever having the value.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { dateTime, EMDASH, relativeTime } from "@/lib/format";
import {
  healthPresentation,
  nextRunPrefix,
  syncHealthState,
  syncScheduleState,
} from "@/lib/audienceSyncHealth";
import {
  destinationTypeLabel,
  scheduleLabel,
  sourceLabel,
  type AudienceSync,
} from "@/lib/audienceSyncs";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AudienceSyncSummary({
  sync,
  now,
}: {
  sync: AudienceSync;
  now: number;
}) {
  const { t } = useTheme();
  const health = healthPresentation(syncHealthState(sync, now));
  const schedule = syncScheduleState(sync, now);
  const nextLabel =
    schedule.at === null
      ? nextRunPrefix(schedule.reason)
      : `${nextRunPrefix(schedule.reason)} ${relativeTime(schedule.at, { now })}`;
  const nextSpoken =
    schedule.at === null
      ? nextRunPrefix(schedule.reason)
      : `${nextRunPrefix(schedule.reason)} ${dateTime(schedule.at)}`;

  return (
    <View style={{ gap: 10 }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Pill
          label={health.label}
          tone={health.tone}
          accessibilityLabel={health.spoken}
        />
        <Pill label={destinationTypeLabel(sync.destination.type)} tone="accent" />
        <Pill label={scheduleLabel(sync.schedule)} tone="neutral" />
        <Pill
          label={sync.enabled ? "Enabled" : "Paused"}
          tone={sync.enabled ? "success" : "neutral"}
          accessibilityLabel={
            sync.enabled
              ? "Enabled: the scheduler runs this on its schedule."
              : "Paused: the scheduler skips this sync entirely, and the server also refuses a manual run while it is paused."
          }
        />
      </View>

      <SummaryLine
        label="Source"
        value={sourceLabel(sync)}
        spoken={`The audience comes from a ${sourceLabel(
          sync,
        ).toLowerCase()}. Which one is chosen on desktop.`}
      />
      <SummaryLine label="Next run" value={nextLabel} spoken={nextSpoken} />
      <SummaryLine
        label="Last run"
        value={sync.lastRunAt ? relativeTime(sync.lastRunAt, { now }) : EMDASH}
        spoken={
          sync.lastRunAt
            ? dateTime(sync.lastRunAt)
            : "It has never completed a run."
        }
      />
      {sync.requiredConsentPurpose ? (
        <SummaryLine
          label="Consent purpose"
          value={sync.requiredConsentPurpose}
          spoken={`Only members who consented to ${sync.requiredConsentPurpose} are sent.`}
        />
      ) : null}

      <DestinationCard sync={sync} />

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        The source, the destination and the schedule are edited on desktop. This
        screen is here to tell you whether the machinery is working.
      </Text>
    </View>
  );
}

/** The receiver, and whether the batches it gets are verifiable. */
function DestinationCard({ sync }: { sync: AudienceSync }) {
  const { t } = useTheme();
  const webhook = sync.destination.type.trim().toLowerCase() === "webhook";
  const signed = sync.destination.secretSet;
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        gap: 4,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.semibold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        Destination
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {webhook
          ? sync.destination.url || EMDASH
          : destinationTypeLabel(sync.destination.type)}
      </Text>
      {webhook ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: signed ? t.fgMuted : t.warning,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {signed
            ? `Signed with an HMAC key ending ${
                sync.destination.secretHint || "in a hidden tail"
              }. The key itself is never sent to this device.`
            : "No signing key is set, so the receiver cannot verify these batches came from Moosewave."}
        </Text>
      ) : null}
    </View>
  );
}

function SummaryLine({
  label,
  value,
  spoken,
}: {
  label: string;
  value: string;
  spoken: string;
}) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${spoken}`}
      style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
          flexShrink: 1,
          textAlign: "right",
        }}
      >
        {value}
      </Text>
    </View>
  );
}
