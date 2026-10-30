/**
 * RunDetailCard — everything the server recorded about ONE run.
 *
 * WHY THERE IS NO `GET /runs/{id}` CALL BEHIND THIS. The collection route and
 * the item route select the identical 23 columns into the identical `SyncRun`
 * struct (`Repo.ListRuns` repo.go:696-702 vs `getRunTx` repo.go:1076-1082), so
 * the row already in hand IS the detail. Firing a second request to receive a
 * byte-identical payload would be a round trip bought with somebody's cellular
 * data and paid for with a spinner.
 *
 * THE COUNTER GRID IS THE POINT OF THIS COMPONENT. Five figures that are only
 * ever written by `completeRunTx` — which sets `status='completed'` in the
 * same UPDATE (repo.go:1023-1036). On any other status they are the column
 * DEFAULT 0 and mean "never measured". Every tile therefore renders an
 * em-dash, with a spoken label that says WHY there is no number, rather than a
 * zero that a reader would take as a count.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { transitionLabel } from "@/lib/direction";
import { EMDASH, dateTime, duration, num, truncateMiddle } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import type { RunEvidence } from "@/lib/warehouseRunErrors";
import type { WarehouseRun } from "@/lib/warehouseRuns";

const UNMEASURED_REASON =
  "not measured — row counts are only written when a run completes";

function Metric({
  label,
  run,
  value,
}: {
  label: string;
  run: WarehouseRun;
  value: number;
}) {
  const { t } = useTheme();
  const measured = run.countersMeasured;
  return (
    <View
      accessible
      accessibilityLabel={
        measured ? `${num(value)} ${label}` : `${label}: ${UNMEASURED_REASON}`
      }
      style={{
        minWidth: 96,
        flexGrow: 1,
        flexBasis: "30%",
        paddingVertical: 6,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("numeric")}
        style={{
          color: t.fg,
          ...typeStyle("numeric"),
          marginTop: 2,
          fontFamily: FONT.semibold,
        }}
      >
        {measured ? num(value) : EMDASH}
      </Text>
    </View>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{ flexDirection: "row", gap: 10, minHeight: 24 }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("bodySmall"),
          width: 92,
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <Text
        selectable
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          flex: 1,
          fontFamily: FONT.regular,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

export function RunDetailCard({
  run,
  connectionName,
  evidence,
}: {
  run: WarehouseRun;
  connectionName: string;
  evidence: RunEvidence;
}) {
  const { t } = useTheme();
  // The headline is emphasised only when it is a FAILURE the reader has to
  // act on — never for a clean completion, where bolding it would make every
  // healthy run look like an alert.
  const failed =
    evidence.kind === "run_error" ||
    evidence.kind === "run_error_missing" ||
    evidence.kind === "rows_failed_unexplained" ||
    evidence.kind === "row_reasons";
  const tone = failed ? t.danger : t.fg;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 12,
      }}
    >
      <View
        accessible
        accessibilityLabel={`${connectionName}, ${run.status || "unknown status"}. ${evidence.headline} ${evidence.detail}`}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <Pill label={run.direction || "unknown"} tone="neutral" />
          <Pill label={run.runMode || "unknown mode"} tone="neutral" />
          {run.retryCount > 0 ? (
            <Pill label={`retry ${run.retryCount}`} tone="warning" />
          ) : null}
        </View>
        <Text
          selectable
          {...typeCap("body")}
          style={{
            color: tone,
            ...typeStyle("body"),
            marginTop: 10,
            fontWeight: failed ? "600" : "400",
            fontFamily: failed ? FONT.semibold : FONT.regular,
          }}
        >
          {evidence.headline}
        </Text>
        {evidence.detail ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              marginTop: 6,
              fontFamily: FONT.regular,
            }}
          >
            {evidence.detail}
          </Text>
        ) : null}
      </View>

      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          borderTopWidth: 1,
          borderTopColor: t.borderSubtle,
          paddingTop: 6,
        }}
      >
        <Metric label="Scanned" run={run} value={run.rowsScanned} />
        <Metric label="Exported" run={run} value={run.rowsExported} />
        <Metric label="Imported" run={run} value={run.rowsImported} />
        <Metric label="Failed rows" run={run} value={run.rowsFailed} />
        <Metric label="Schema errors" run={run} value={run.schemaErrors} />
      </View>

      <View
        style={{
          gap: 4,
          borderTopWidth: 1,
          borderTopColor: t.borderSubtle,
          paddingTop: 10,
        }}
      >
        <Line label="Queued" value={dateTime(run.createdAt, EMDASH)} />
        <Line label="Started" value={dateTime(run.startedAt, EMDASH)} />
        <Line label="Finished" value={dateTime(run.completedAt, EMDASH)} />
        <Line
          label="Took"
          value={run.durationMs === null ? EMDASH : duration(run.durationMs)}
        />
        <Line
          label="Objects"
          value={
            run.objectSelection.length > 0
              ? run.objectSelection.join(", ")
              : "none recorded"
          }
        />
        {run.outputUri ? (
          <Line label="Output" value={truncateMiddle(run.outputUri, 42)} />
        ) : null}
        {run.inputUri ? (
          <Line label="Input" value={truncateMiddle(run.inputUri, 42)} />
        ) : null}
        {run.cursorFrom || run.cursorTo ? (
          <Line
            label="Cursor"
            // `transitionLabel`, not a literal arrow: the connector has to
            // flip with the layout or the cursor window reads backwards in RTL.
            value={transitionLabel(
              run.cursorFrom || EMDASH,
              run.cursorTo || EMDASH,
            )}
          />
        ) : null}
      </View>
    </View>
  );
}
