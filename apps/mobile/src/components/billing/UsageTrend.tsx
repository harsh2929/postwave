/**
 * UsageTrend — send volume over time on the Plan & usage screen.
 *
 * A static usage bar answers "how much have I used"; it cannot answer "is this
 * month unusual", which is the question people actually open billing to ask
 * during an incident. GET /api/v1/billing/usage returns a per-day series and
 * the app already ships a charting primitive, so the only thing missing was
 * the wiring.
 *
 * The window selector is the server's supported set (30 / 90 / 365) and
 * nothing else: the handler silently clamps anything unrecognised to 90, so
 * offering a fourth option would show a window the user did not choose.
 */
import { Text, View } from "react-native";

import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Skeleton, SkeletonGroup } from "@/components/Skeleton";
import type { UsagePoint, UsageWindow } from "@/api/billing";
import { FONT } from "@/lib/fonts";
import { date } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const WINDOW_OPTIONS = [
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
  { value: "365", label: "1y" },
] as const;

export interface UsageTrendProps {
  points: readonly UsagePoint[];
  window: UsageWindow;
  onWindowChange: (next: UsageWindow) => void;
  loading: boolean;
  /** True when the series could not be loaded — we say so rather than plot zero. */
  failed: boolean;
}

export function UsageTrend({
  points,
  window,
  onWindowChange,
  loading,
  failed,
}: UsageTrendProps) {
  const { t } = useTheme();

  return (
    <View style={{ marginBottom: 20 }}>
      <View style={{ marginBottom: 12 }}>
        <SegmentedControl
          options={WINDOW_OPTIONS}
          value={String(window) as "30" | "90" | "365"}
          onChange={(next) => onWindowChange(Number(next) as UsageWindow)}
          accessibilityLabel="Usage window"
        />
      </View>
      {loading ? (
        <SkeletonGroup label="Loading send history">
          <Skeleton height={160} radius={14} />
        </SkeletonGroup>
      ) : failed ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("bodySmall"),
          }}
        >
          Send history couldn&apos;t be loaded. Pull to refresh.
        </Text>
      ) : points.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("bodySmall"),
          }}
        >
          No sends recorded in this window.
        </Text>
      ) : (
        <TimeSeriesChart
          series={[
            {
              id: "sent",
              label: "Sends",
              values: points.map((p) => p.sent),
            },
          ]}
          labels={points.map((p) => date(p.date))}
          title="Sends per day"
          valueNoun="sends"
          area
        />
      )}
    </View>
  );
}
