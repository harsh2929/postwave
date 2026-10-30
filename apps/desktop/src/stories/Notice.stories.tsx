/**
 * Stories for the Notice primitive — one story per tone plus a
 * story for the `action` slot. Rendered statically so the
 * Playwright visual-regression workflow captures the chrome
 * unambiguously.
 */
import type { Meta, StoryObj } from "@storybook/react";

import { Notice } from "../components/Notice";

const meta: Meta<typeof Notice> = {
  title: "Primitives/Notice",
  component: Notice,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof Notice>;

export const Info: Story = {
  args: {
    tone: "info",
    title: "Heads up",
    children: "Click any framework card to open its attestation detail.",
  },
};

export const Success: Story = {
  args: {
    tone: "success",
    title: "Attestation saved",
    children: "Posture refreshed in the audit ledger.",
  },
};

export const Warning: Story = {
  args: {
    tone: "warning",
    title: "Renewal due in 14 days",
    children: "Schedule a follow-up before the existing attestation expires.",
  },
};

export const Danger: Story = {
  args: {
    tone: "danger",
    title: "Live status unavailable",
    children: "Showing default state — refresh the page to retry.",
  },
};

export const Neutral: Story = {
  args: {
    tone: "neutral",
    children: "A neutral tone is helpful for soft hints inline with copy.",
  },
};

export const WithAction: Story = {
  args: {
    tone: "warning",
    title: "Sink delivery failing",
    children:
      "Three deliveries to s3://acme-audit/ failed in the last hour.",
    action: (
      <button type="button" className="btn btn-sm btn-secondary">
        View sink
      </button>
    ),
  },
};

export const AssertiveOverride: Story = {
  args: {
    tone: "warning",
    announcement: "assertive",
    title: "Send requires intervention",
    children: "A required compliance footer is missing.",
  },
};
