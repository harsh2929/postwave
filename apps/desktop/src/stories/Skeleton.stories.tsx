/**
 * Stories for the Skeleton primitive. Covers the three variants and
 * the `lines` shortcut used to render multi-row text placeholders.
 *
 * The shimmer animation is paused in CI for visual-regression
 * determinism (see preview.ts), so these snapshots are stable.
 */
import type { Meta, StoryObj } from "@storybook/react";

import { Skeleton } from "../components/Skeleton";

const meta: Meta<typeof Skeleton> = {
  title: "Primitives/Skeleton",
  component: Skeleton,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof Skeleton>;

export const Row: Story = {
  args: { variant: "row", width: 240 },
};

export const Card: Story = {
  args: { variant: "card", width: 320 },
};

export const Circle: Story = {
  args: { variant: "circle" },
};

export const MultiLine: Story = {
  args: { lines: 4, "aria-label": "Loading message preview" },
  render: (args) => (
    <div style={{ width: 320 }}>
      <Skeleton {...args} />
    </div>
  ),
};

export const DecorativeGroup: Story = {
  render: () => (
    <div role="status" aria-label="Loading account summary">
      <Skeleton lines={3} />
    </div>
  ),
};

export const TableRows: Story = {
  render: () => (
    <div style={{ width: 480, display: "grid", gap: 6 }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: "32px 1fr 80px",
            alignItems: "center",
            gap: 12,
          }}
        >
          <Skeleton variant="circle" />
          <Skeleton variant="row" />
          <Skeleton variant="row" width={64} />
        </div>
      ))}
    </div>
  ),
};
