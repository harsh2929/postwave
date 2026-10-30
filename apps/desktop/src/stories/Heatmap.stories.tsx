/**
 * Stories for Heatmap — cohort retention grid.
 *
 * Cohort labels are anchored to fixed months so snapshots don't drift
 * when CI runs on different days.
 */
import type { Meta, StoryObj } from "@storybook/react";

import { Heatmap } from "../components/charts/Heatmap";

const meta: Meta<typeof Heatmap> = {
  title: "Charts/Heatmap",
  component: Heatmap,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof Heatmap>;
const STORY_SUPPORT = {
  provenance: {
    source: "Deterministic Storybook fixture",
    asOf: null,
    scope: "Story",
  },
  exportFileName: "storybook-retention.csv",
  exportPrivacy: "public" as const,
  valueLabel: "Open rate",
};

function makeRows(): {
  label: string;
  size: number;
  values: (number | null)[];
}[] {
  // 6 cohort rows × 8 week columns. Retention generally decays; a few
  // NaN cells exercise the "no data" styling.
  const cohorts = [
    "2025-12",
    "2026-01",
    "2026-02",
    "2026-03",
    "2026-04",
    "2026-05",
  ];
  return cohorts.map((label, i) => ({
    label: `${label} cohort`,
    size: 420 - i * 35,
    values: Array.from({ length: 8 }).map((_, w) => {
      if (i + w > 8) return null;
      const base = 1 - w * 0.09 - i * 0.01;
      return Math.max(0.05, Math.min(1, base));
    }),
  }));
}

export const Retention: Story = {
  name: "Retention · 6×8",
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <Heatmap
        {...STORY_SUPPORT}
        rows={makeRows()}
        columns={["W0", "W1", "W2", "W3", "W4", "W5", "W6", "W7"]}
        metricLabel="Open rate"
      />
    </div>
  ),
};

export const Empty: Story = {
  name: "No data",
  render: () => (
    <Heatmap
      {...STORY_SUPPORT}
      rows={[]}
      columns={["W0", "W1", "W2"]}
      metricLabel="Open rate"
    />
  ),
};
