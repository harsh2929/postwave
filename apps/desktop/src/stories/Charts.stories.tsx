/**
 * Stories for the three SVG chart primitives.
 *
 * All three are hand-rolled SVG (no external chart lib) and consume
 * `--pw-accent`/`--pw-border`/etc design tokens. Stories use deterministic
 * synthetic data so visual-regression snapshots stay stable across runs
 * — no `Math.random()`, no `new Date()` without a fixed seed.
 *
 * Only LineChart owns the default export here; Sparkline and Heatmap
 * have sibling story files so each component shows up under its own
 * sidebar entry in Storybook.
 */
import type { Meta, StoryObj } from "@storybook/react";

import { LineChart } from "../components/charts/LineChart";

const meta: Meta<typeof LineChart> = {
  title: "Charts/LineChart",
  component: LineChart,
  parameters: {
    layout: "padded",
  },
};

export default meta;

type LineStory = StoryObj<typeof LineChart>;
const STORY_SUPPORT = {
  title: "Subscriber growth",
  provenance: {
    source: "Deterministic Storybook fixture",
    asOf: null,
    scope: "Story",
  },
  exportFileName: "storybook-subscriber-growth.csv",
  exportPrivacy: "public" as const,
  valueLabel: "Subscribers",
};

function makeLineData(
  days: number,
  base: number,
  slope: number,
): { date: string; count: number }[] {
  // Deterministic synthetic series — anchored to a fixed start date so
  // x-tick labels never drift between snapshot runs.
  const start = new Date("2026-01-01T00:00:00Z");
  const out: { date: string; count: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    // Mild oscillation around the trend so the line has shape.
    const wobble = Math.sin(i * 0.6) * (base * 0.04);
    out.push({
      date: d.toISOString().slice(0, 10),
      count: Math.max(0, Math.round(base + slope * i + wobble)),
    });
  }
  return out;
}

export const ThirtyDayGrowth: LineStory = {
  name: "30-day growth",
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <LineChart
        {...STORY_SUPPORT}
        data={makeLineData(30, 1000, 18)}
        height={220}
      />
    </div>
  ),
};

export const Flat: LineStory = {
  name: "Flat (no movement)",
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <LineChart
        {...STORY_SUPPORT}
        data={makeLineData(14, 500, 0).map((p) => ({ ...p, count: 500 }))}
        height={180}
      />
    </div>
  ),
};
