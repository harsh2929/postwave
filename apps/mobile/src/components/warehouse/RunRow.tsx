/**
 * RunRow — one warehouse sync run, at a glance.
 *
 * WHAT LEADS. The connection name and the OUTCOME, in that order: an operator
 * scanning this list is looking for the one red word, and everything else on
 * the row exists to tell them whether it is worth opening.
 *
 * WHAT IS DELIBERATELY NOT SHOWN AS A NUMBER. Row counters are only written by
 * `completeRunTx`, which also sets `status='completed'` — so on a queued,
 * running, failed or cancelled run those columns are still the migration's
 * DEFAULT 0 and mean "never measured". `run.countersMeasured` carries that,
 * and this row renders an em-dash rather than a "0 rows" that would read as a
 * measurement nobody took.
 *
 * State is never colour alone: the outcome is a labelled Pill AND the row's
 * spoken label starts with the same word.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill, type PillTone } from "@/components/Pill";
import { EMDASH, dateTime, duration, num, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import type { WarehouseRun, WarehouseRunOutcome } from "@/lib/warehouseRuns";

const OUTCOME_TONE: Readonly<Record<WarehouseRunOutcome, PillTone>> = {
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
  running: "info",
  queued: "neutral",
  unknown: "warning",
};

export interface RunRowProps {
  run: WarehouseRun;
  connectionName: string;
  selected: boolean;
  onSelect: (id: string) => void;
}

/**
 * The one number worth putting on a list row: what the run actually moved.
 * Import runs move rows IN, export runs move rows OUT; showing both would put
 * a permanent zero next to every row in a tenant that only exports.
 */
function movedLabel(run: WarehouseRun): { text: string; spoken: string } {
  if (!run.countersMeasured) {
    return {
      text: EMDASH,
      spoken: "no row count — a run only records one when it completes",
    };
  }
  const moved =
    run.direction === "import" ? run.rowsImported : run.rowsExported;
  const noun = run.direction === "import" ? "imported" : "exported";
  return {
    text: `${num(moved)} ${noun}`,
    spoken: `${num(moved)} rows ${noun}`,
  };
}

export function RunRow({
  run,
  connectionName,
  selected,
  onSelect,
}: RunRowProps) {
  const { t } = useTheme();
  const moved = movedLabel(run);
  const started = relativeTime(run.createdAt, { fallback: "" });
  const absolute = dateTime(run.createdAt, "");
  const took = run.durationMs === null ? EMDASH : duration(run.durationMs);
  const failedRows =
    run.countersMeasured && run.rowsFailed > 0
      ? `${num(run.rowsFailed)} failed`
      : "";

  return (
    <Pressable
      onPress={() => onSelect(run.id)}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={[
        `${run.status || "unknown status"}.`,
        `${connectionName}, ${run.direction || "unknown direction"} run`,
        run.dryRun ? "in dry-run mode" : "",
        absolute ? `started ${absolute}.` : "with no start time recorded.",
        `${moved.spoken}.`,
        failedRows ? `${num(run.rowsFailed)} rows failed.` : "",
        run.durationMs === null ? "" : `Took ${took}.`,
        selected ? "Showing its detail." : "Show its detail.",
      ]
        .filter(Boolean)
        .join(" ")}
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
            {connectionName}
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
            {[
              run.direction || "unknown",
              run.runMode,
              started ? `started ${started}` : "no start time",
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
        <Pill
          label={run.status || "unknown"}
          tone={OUTCOME_TONE[run.outcome]}
        />
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          marginTop: 10,
          flexWrap: "wrap",
        }}
      >
        <Text
          // Hidden from assistive tech: the row's own label already speaks
          // the exact figures, and a second stop would repeat them compacted.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {moved.text}
        </Text>
        {failedRows ? (
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            {...typeCap("caption")}
            style={{
              color: t.danger,
              ...typeStyle("caption"),
              fontFamily: FONT.semibold,
            }}
          >
            {failedRows}
          </Text>
        ) : null}
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {took === EMDASH ? "no duration" : `took ${took}`}
        </Text>
        {run.dryRun ? <Pill label="dry run" tone="warning" /> : null}
      </View>
    </Pressable>
  );
}
