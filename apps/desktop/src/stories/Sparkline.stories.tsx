/**
 * Stories for Sparkline — tiny inline trend line.
 *
 * Series values are hardcoded (no Math.random) so visual-regression
 * snapshots stay stable across runs.
 */
import type { Meta, StoryObj } from "@storybook/react";

import { Sparkline } from "../components/charts/Sparkline";

const meta: Meta<typeof Sparkline> = {
  title: "Charts/Sparkline",
  component: Sparkline,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof Sparkline>;

export const Up: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
      <Sparkline values={[10, 14, 13, 18, 22, 26, 32, 41]} />
      <span style={{ fontSize: 13, color: "var(--pw-fg-subtle)" }}>
        opens, last 8 sends
      </span>
    </div>
  ),
};

export const Down: Story = {
  render: () => (
    <Sparkline values={[42, 40, 38, 33, 30, 25, 22, 18]} trend="down" />
  ),
};

export const Empty: Story = {
  name: "No data",
  render: () => <Sparkline values={[]} />,
};
