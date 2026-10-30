/** Reporting window and freshness receipt that sit above the dashboard grid. */
import { View } from "react-native";

import { SegmentedControl } from "@/components/SegmentedControl";
import { LiveDot } from "@/components/dashboard/LiveDot";
import { DASHBOARD_RANGES, type DashboardRange } from "@/hooks/useDashboard";
import { msg } from "@/lib/i18n";
import type { EventBusFreshnessTone } from "@/lib/eventBusStatus";

const RANGE_OPTIONS = DASHBOARD_RANGES.map((range) => ({
  value: range,
  label: range,
}));

export function DashboardReportingControls({
  range,
  onRangeChange,
  lastUpdatedAt,
  now,
  errored,
  stream,
}: {
  range: DashboardRange;
  onRangeChange: (range: DashboardRange) => void;
  lastUpdatedAt: number;
  now: number;
  errored: boolean;
  stream: EventBusFreshnessTone;
}) {
  return (
    <>
      <SegmentedControl
        accessibilityLabel={msg("dashboard.range.a11y")}
        options={RANGE_OPTIONS}
        value={range}
        onChange={onRangeChange}
      />
      <View style={{ height: 12 }} />
      <View
        testID="dashboard-freshness"
        style={{ alignItems: "flex-end", marginBottom: 10 }}
      >
        <LiveDot
          lastUpdatedAt={lastUpdatedAt}
          now={now}
          errored={errored}
          stream={stream}
        />
      </View>
    </>
  );
}
