/**
 * SendingStatusCard — operational evidence beside sending settings.
 *
 * `GET /api/v1/settings/sending/status` reports quiet-hours and distributed
 * cap-coordination state. Its current schema explicitly withholds the active
 * shared counter, so this card renders configuration-only copy until a future
 * response carries qualified authoritative telemetry.
 *
 * Three states this must keep distinct, because collapsing any pair of them is
 * how the old screen lied:
 *   - no cap configured        → "No cap", NOT a 0% bar
 *   - in quiet hours right now → paused, with when it resumes
 *   - status unknown (offline / failed side fetch) → say so, assert nothing
 */
import { Text, View } from "react-native";

import { Meter } from "@/components/deliverability/Meter";
import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { num, relativeTime } from "@/lib/format";
import {
  meterState,
  quietHoursState,
  type SignalTone,
} from "@/lib/deliverabilitySignals";
import type { SendingStatus } from "@/lib/deliverabilityContracts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SendingStatusCardProps {
  status: SendingStatus | undefined;
  /** True when the status fetch failed or could not run (offline). */
  unavailable: boolean;
  unavailableReason: string;
  now?: number | undefined;
}

function pillTone(
  tone: SignalTone,
): "neutral" | "success" | "warning" | "danger" | "info" {
  return tone === "neutral" ? "neutral" : tone;
}

export function SendingStatusCard({
  status,
  unavailable,
  unavailableReason,
  now,
}: SendingStatusCardProps) {
  const { t } = useTheme();

  if (unavailable || !status) {
    return (
      <View
        accessible
        accessibilityLabel={`Live sending status unavailable. ${unavailableReason}`}
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderStyle: "dashed",
          borderRadius: 14,
          padding: 14,
          marginBottom: 16,
          gap: 4,
        }}
      >
        <Text
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontFamily: FONT.semibold,
          }}
        >
          Live status unavailable
        </Text>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {unavailableReason}
        </Text>
      </View>
    );
  }

  const liveBucketCount = status.bucketCount;
  const telemetryReady =
    status.counterAuthoritative &&
    status.counterScope === "shared" &&
    liveBucketCount !== null &&
    status.windowResetsAt !== null;
  const meter =
    telemetryReady && liveBucketCount !== null
      ? meterState(liveBucketCount, status.maxSendsPerHour)
      : null;
  const quiet = quietHoursState(status.inQuietHours, {
    start: status.quietHoursStart,
    end: status.quietHoursEnd,
  });
  const resets = status.windowResetsAt
    ? relativeTime(status.windowResetsAt, now === undefined ? {} : { now })
    : null;
  const caption =
    telemetryReady && liveBucketCount !== null
      ? status.maxSendsPerHour && status.maxSendsPerHour > 0
        ? `${num(liveBucketCount)} of ${num(status.maxSendsPerHour)} this hour · resets ${resets}`
        : `${num(liveBucketCount)} sent this hour · no workspace cap configured · resets ${resets}`
      : "Hourly usage telemetry is unavailable. Configured limits are shown below, but this response does not certify the active shared send counter.";

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 16,
        gap: 12,
      }}
    >
      {meter ? (
        <Meter
          label="Sends this hour"
          fraction={meter.fraction}
          tone={meter.tone}
          caption={caption}
          accessibilityValueText={caption}
        />
      ) : (
        <View accessible accessibilityLabel={caption} style={{ gap: 4 }}>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fg,
              ...typeStyle("label"),
              fontFamily: FONT.semibold,
            }}
          >
            Hourly usage unavailable
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {caption}
          </Text>
        </View>
      )}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Pill label={quiet.label} tone={pillTone(quiet.tone)} size="md" />
        {quiet.active !== null && status.quietChangesAt ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {`${quiet.active ? "Resumes" : "Pauses"} ${relativeTime(
              status.quietChangesAt,
              now === undefined ? {} : { now },
            )}`}
          </Text>
        ) : null}
      </View>
      {status.quietHoursTz ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {`Quiet hours are evaluated in ${status.quietHoursTz}.`}
        </Text>
      ) : null}
    </View>
  );
}
