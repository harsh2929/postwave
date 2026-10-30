/**
 * Stories for the Card primitive. One story per variant plus a story
 * combining title + actions in the header row, so the headed shape
 * is captured in the visual-regression snapshots.
 */
import type { Meta, StoryObj } from "@storybook/react";

import { Card } from "../components/Card";

const meta: Meta<typeof Card> = {
  title: "Primitives/Card",
  component: Card,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof Card>;

const sample = (
  <p style={{ margin: 0, color: "var(--pw-fg-muted)", fontSize: 13 }}>
    This card wraps grouped content. Pick a variant to change how it lifts
    off the page.
  </p>
);

export const Default: Story = {
  args: {
    variant: "default",
    children: sample,
  },
};

export const Elevated: Story = {
  args: {
    variant: "elevated",
    children: sample,
  },
};

export const Subtle: Story = {
  args: {
    variant: "subtle",
    children: sample,
  },
};

export const WithHeader: Story = {
  args: {
    as: "section",
    variant: "default",
    title: "Article 50 readiness",
    actions: (
      <button type="button" className="btn btn-sm btn-secondary">
        Download bundle
      </button>
    ),
    children: sample,
  },
};

export const NoPadding: Story = {
  args: {
    variant: "default",
    padding: "none",
    children: (
      <table className="data-table" style={{ width: "100%" }}>
        <thead>
          <tr>
            <th>Framework</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>HIPAA</td>
            <td>Attested</td>
          </tr>
          <tr>
            <td>SOC 2</td>
            <td>Attested</td>
          </tr>
        </tbody>
      </table>
    ),
  },
};
