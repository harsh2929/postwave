/**
 * SyncVerdictCard — the answer to "did last night's sync land?", with the
 * qualifier that keeps it honest.
 *
 * The whole judgement is in `lib/warehouseVerdict` (pure, node-tested); this
 * component only paints it. The qualifier is NOT optional decoration: the run
 * feed is the newest N runs across every connection, so a connection with no
 * run in that page may simply have been pushed off the end. Presenting
 * "3 connections had no run" without saying what it was read from would be
 * turning a truncation artefact into an incident report.
 */
import { Text, View } from "react-native";

import { Pill, type PillTone } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import type {
  ConnectionRunState,
  WarehouseSyncVerdict,
} from "@/lib/warehouseVerdict";
import { verdictHeadline, verdictQualifier } from "@/lib/warehouseVerdict";

const STATE_TONE: Readonly<Record<ConnectionRunState, PillTone>> = {
  landed: "success",
  failed: "danger",
  in_flight: "info",
  cancelled: "neutral",
  unknown: "warning",
  no_run_in_window: "warning",
};

/** Never an abbreviation and never colour alone — the pill carries the word. */
const STATE_WORD: Readonly<Record<ConnectionRunState, string>> = {
  landed: "landed",
  failed: "failed",
  in_flight: "running",
  cancelled: "cancelled",
  unknown: "unknown",
  no_run_in_window: "no run here",
};

export function SyncVerdictCard({
  verdict,
}: {
  verdict: WarehouseSyncVerdict;
}) {
  const { t } = useTheme();
  const headline = verdictHeadline(verdict);
  const qualifier = verdictQualifier(verdict);
  const tone: PillTone =
    verdict.failed > 0
      ? "danger"
      : verdict.unseen > 0
        ? "warning"
        : verdict.expected === 0
          ? "neutral"
          : "success";

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 12,
        gap: 10,
      }}
    >
      <View accessible accessibilityLabel={`${headline} ${qualifier}`}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Pill
            label={verdict.failed > 0 ? "attention" : "scheduled syncs"}
            tone={tone}
          />
        </View>
        <Text
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            marginTop: 8,
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {headline}
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {qualifier}
        </Text>
      </View>

      {verdict.rows.length > 0 ? (
        <View style={{ gap: 6 }}>
          {verdict.rows.map((row) => (
            <View
              key={row.connectionId}
              accessible
              accessibilityLabel={`${row.name}, ${row.cadence} schedule: ${STATE_WORD[row.state]}.`}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                minHeight: 28,
              }}
            >
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("bodySmall"),
                  flex: 1,
                  fontFamily: FONT.regular,
                }}
                numberOfLines={1}
              >
                {row.name}
              </Text>
              <Pill label={STATE_WORD[row.state]} tone={STATE_TONE[row.state]} />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
