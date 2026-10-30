/**
 * ConnectionRunHistory — the runs behind one provider-family row.
 *
 * P2.40: the phone could re-run a write-back target and could not see whether
 * the last run failed or why. Mounted only while the row is expanded (so a
 * collapsed panel of twelve rows costs zero run requests), at the LIST's role
 * floor — every family's `GET {base}/{id}/runs` is ScopeReadReports, so the
 * viewer who is shown a failing row is also shown the failure.
 *
 * Four states, none of them silent: offline (the gate never let the query run
 * — TanStack reports that as pending/idle, which is NOT loading), failed
 * (named, so a 500 is never read as "no runs"), empty, and rows. The server's
 * error_message is rendered whole: desktop clips it to 80 characters behind a
 * hover tooltip, and a phone has no hover.
 *
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import type { ConnectionFamily } from "@/api/connectionFamilies";
import { Pill } from "@/components/Pill";
import { useConnectionRuns } from "@/hooks/useConnectionRuns";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  runCountsLine,
  runSpoken,
  runTone,
  type ConnectionRun,
} from "@/lib/connectionRuns";
import { dateTime, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export const RUN_HISTORY_COPY = {
  offline: "Run history needs a connection. Reconnect and pull to refresh.",
  failed:
    "Couldn't load run history. Pull to refresh — this is not the same as having no runs.",
  loading: "Loading runs…",
  empty: "No runs yet.",
} as const;

export function ConnectionRunHistory({
  family,
  id,
}: {
  family: ConnectionFamily;
  id: string;
}) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const runs = useConnectionRuns(family, id);
  // A type check, not a coalesce: `?? []` would wave a truthy non-array
  // straight into .map (lib/nullishArrayGuard.test.ts).
  const rows = Array.isArray(runs.data) ? runs.data : [];

  let notice: string | null = null;
  let color = t.fgSubtle;
  if (!gate.enabled) {
    notice = RUN_HISTORY_COPY.offline;
  } else if (runs.isError) {
    notice = RUN_HISTORY_COPY.failed;
    color = t.warning;
  } else if (runs.data === undefined) {
    notice = RUN_HISTORY_COPY.loading;
  } else if (rows.length === 0) {
    notice = RUN_HISTORY_COPY.empty;
  }

  if (notice !== null) {
    return (
      <Text
        {...(runs.isError ? { accessibilityRole: "alert" as const } : {})}
        {...typeCap("caption")}
        style={{
          color,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          paddingVertical: 6,
        }}
      >
        {notice}
      </Text>
    );
  }

  return (
    <View style={{ gap: 8, paddingTop: 4 }}>
      {rows.map((run) => (
        <RunRow key={run.id} run={run} />
      ))}
    </View>
  );
}

function RunRow({ run }: { run: ConnectionRun }) {
  const { t } = useTheme();
  const when = relativeTime(run.startedAt);
  const counts = runCountsLine(run);
  return (
    <View
      accessible
      accessibilityLabel={runSpoken(run, dateTime(run.startedAt))}
      style={{ gap: 2 }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Pill label={run.status || "unknown"} tone={runTone(run.status)} />
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {run.runMode ? `${when} · ${run.runMode}` : when}
        </Text>
      </View>
      {counts ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
        >
          {counts}
        </Text>
      ) : null}
      {run.errorMessage ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {run.errorMessage}
        </Text>
      ) : null}
    </View>
  );
}
