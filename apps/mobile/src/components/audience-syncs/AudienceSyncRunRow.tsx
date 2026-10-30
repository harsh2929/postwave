/**
 * AudienceSyncRunRow — one entry in a sync's run history, and the only place
 * WHAT BROKE is written down.
 *
 * THE THREE NUMBERS ARE NOT INTERCHANGEABLE, and conflating them is the easiest
 * way to make this screen lie:
 *   - `source_members_observed` is how many the list/segment resolved to;
 *   - `excluded_count` is how many the activation firewall WITHHELD for missing
 *     consent or suppression (migration 0407);
 *   - `rows_exported` is how many actually left.
 * A row that showed only the last of the three would let an operator conclude
 * their audience shrank when in fact their consent posture tightened. All three
 * are shown, and each renders an EM-DASH when the field was absent — never a
 * zero, because "0 delivered" is a serious claim and a missing field is not it.
 *
 * `cap_exceeded` IS A SEPARATE FACT FROM THE STATUS. A run can be `rejected`
 * because the source blew `SyncMaxRows` (50,000), and the flag is what says so;
 * the status alone would leave the reader guessing which of several failures it
 * was.
 *
 * PROVIDER FIELDS ARE ONLY EVER SHOWN WHEN PRESENT. `external_job_id`,
 * `provider_status` and `provider_message` are populated only for ad-platform
 * destinations that answered, and they are echoed verbatim rather than
 * translated: a provider's own words are the operator's lead when they open a
 * support ticket with that provider.
 */
import { Text, useWindowDimensions, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { dateTime, duration, EMDASH, num, relativeTime } from "@/lib/format";
import {
  runDurationMs,
  runStatusPresentation,
  triggerLabel,
  type AudienceSyncRun,
} from "@/lib/audienceSyncs";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface AudienceSyncRunRowProps {
  run: AudienceSyncRun;
  now: number;
}

export function AudienceSyncRunRow({ run, now }: AudienceSyncRunRowProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const status = runStatusPresentation(run, now);
  const elapsed = runDurationMs(run, now);
  // A run with no parsable start has no duration to state; an em-dash says so.
  const took = elapsed === null ? EMDASH : duration(elapsed);
  const started = run.startedAt ? relativeTime(run.startedAt, { now }) : EMDASH;
  const startedSpoken = run.startedAt
    ? `Started ${dateTime(run.startedAt)}`
    : "Its start time was not recorded";

  const withheld =
    run.excludedCount !== null && run.excludedCount > 0
      ? ` The consent firewall withheld ${num(run.excludedCount)}.`
      : "";

  return (
    <View
      accessible
      accessibilityLabel={`${status.spoken} ${startedSpoken}, ${triggerLabel(
        run.triggerKind,
      ).toLowerCase()}. ${
        run.rowsExported === null
          ? "The number delivered was not recorded."
          : `${num(run.rowsExported)} delivered.`
      }${withheld}${run.error ? ` Error: ${run.error}` : ""}`}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 6,
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
        <Pill
          label={status.label}
          tone={status.tone}
          accessibilityLabel={status.spoken}
        />
        <Text
          numberOfLines={1}
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            flexShrink: 1,
          }}
        >
          {started} · {took} · {triggerLabel(run.triggerKind)}
        </Text>
      </View>

      <RunCounts run={run} />

      {run.capExceeded ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.warning,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          The source is larger than the 50,000-member per-run cap, so this run
          was stopped before anything was sent.
        </Text>
      ) : null}

      {run.error ? (
        <Text
          numberOfLines={maxLinesAtScale(6, fontScale)}
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {run.error}
        </Text>
      ) : null}

      <ProviderEvidence run={run} />
    </View>
  );
}

/**
 * Resolved → withheld → delivered, in that order, because that is the order the
 * runner applies them and it is the only order in which the three numbers
 * explain each other.
 */
function RunCounts({ run }: { run: AudienceSyncRun }) {
  const { t } = useTheme();
  const cells: { label: string; value: string; spoken: string }[] = [
    {
      label: "Resolved",
      value: num(run.sourceMembersObserved),
      spoken:
        run.sourceMembersObserved === null
          ? "not recorded"
          : `${run.sourceMembersObserved} members resolved from the source`,
    },
    {
      label: "Withheld",
      value: num(run.excludedCount),
      spoken:
        run.excludedCount === null
          ? "not recorded"
          : `${run.excludedCount} withheld by the consent firewall`,
    },
    {
      label: "Delivered",
      value: num(run.rowsExported),
      spoken:
        run.rowsExported === null
          ? "not recorded"
          : `${run.rowsExported} delivered in ${run.batchesSent ?? 0} batches`,
    },
  ];
  return (
    <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
      {cells.map((cell) => (
        <View
          key={cell.label}
          accessible
          accessibilityLabel={`${cell.label}: ${cell.spoken}`}
          style={{ gap: 1 }}
        >
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.semibold,
              letterSpacing: 0.4,
              textTransform: "uppercase",
            }}
          >
            {cell.label}
          </Text>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.medium,
            }}
          >
            {cell.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Only rendered when the destination provider actually said something. */
function ProviderEvidence({ run }: { run: AudienceSyncRun }) {
  const { t } = useTheme();
  const parts = [
    run.providerStatus ? `Provider status ${run.providerStatus}` : "",
    run.externalJobID ? `Job ${run.externalJobID}` : "",
    run.externalAudienceID ? `Audience ${run.externalAudienceID}` : "",
  ].filter((part) => part !== "");
  if (parts.length === 0 && !run.providerMessage) return null;
  return (
    <View style={{ gap: 2 }}>
      {parts.length > 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.medium,
          }}
        >
          {parts.join(" · ")}
        </Text>
      ) : null}
      {run.providerMessage ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {run.providerMessage}
        </Text>
      ) : null}
    </View>
  );
}
