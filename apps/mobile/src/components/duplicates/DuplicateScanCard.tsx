/**
 * DuplicateScanCard — what the scan actually covered.
 *
 * The verdict line is the only number on this surface that may be stated
 * without a denominator: `candidate_count` is a `count(*)` over the whole
 * frozen manifest (scan.go:272-276), not over the page the device fetched. The
 * card says so out loud, because "12 candidate pairs" and "12 candidate pairs
 * so far" are different claims and the wrong one sends someone hunting for
 * duplicates that do not exist.
 *
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { dateTime, EMDASH, num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import {
  duplicateScanVerdict,
  scanIsExpired,
  type DuplicateScan,
} from "@/lib/duplicateScan";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface DuplicateScanCardProps {
  scan: DuplicateScan;
  /** Injected so the expiry branch is testable without faking the clock. */
  nowMs?: number | undefined;
}

export function DuplicateScanCard({ scan, nowMs }: DuplicateScanCardProps) {
  const { t } = useTheme();
  const verdict = duplicateScanVerdict(scan);
  const expired = scanIsExpired(scan, nowMs ?? Date.now());
  const finished = scan.completedAt || scan.createdAt;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: expired ? t.warning : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 16,
        gap: 10,
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
        <Text
          accessibilityRole="header"
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
        >
          This scan
        </Text>
        {/* State is never colour-alone: the pill carries the word too. */}
        <Pill
          label={expired ? "Expired" : scan.complete ? "Complete" : "Running"}
          tone={expired ? "warning" : scan.complete ? "success" : "info"}
          accessibilityLabel={
            expired
              ? "This scan has expired"
              : scan.complete
                ? "This scan is complete"
                : "This scan is still running"
          }
        />
      </View>

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {verdict}
      </Text>

      <View style={{ flexDirection: "row", gap: 20, flexWrap: "wrap" }}>
        <Figure
          label="People scanned"
          value={scan.subscriberCount === null ? EMDASH : num(scan.subscriberCount)}
          missing="The server did not report how many people were scanned"
        />
        <Figure
          label="Candidate pairs"
          value={scan.candidateCount === null ? EMDASH : num(scan.candidateCount)}
          missing="The server did not report a candidate total"
        />
      </View>

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {expired
          ? `Frozen ${dateTime(finished)} and now expired — merges against it will be refused. Pull to refresh to scan again.`
          : `Frozen ${dateTime(finished)}. It is a snapshot, so a record edited since then is marked stale below.`}
      </Text>
    </View>
  );
}

/**
 * One figure. An absent measurement renders an em-dash and SAYS WHY to
 * assistive tech — a screen reader hearing "dash" learns nothing.
 */
function Figure({
  label,
  value,
  missing,
}: {
  label: string;
  value: string;
  missing: string;
}) {
  const { t } = useTheme();
  const absent = value === EMDASH;
  return (
    <View
      accessible
      accessibilityLabel={absent ? `${missing}, ${label}` : `${value} ${label}`}
      style={{ gap: 2 }}
    >
      <Text
        {...typeCap("heading")}
        style={{
          color: absent ? t.fgSubtle : t.fg,
          ...typeStyle("heading"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {value}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
