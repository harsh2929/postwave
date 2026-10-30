/**
 * Stories for the Banner primitive. Banners are larger than Notices
 * and host an optional dismiss affordance plus a trailing CTA. The
 * stories cover both shapes.
 */
import type { Meta, StoryObj } from "@storybook/react";

import { Banner } from "../components/Banner";

const meta: Meta<typeof Banner> = {
  title: "Primitives/Banner",
  component: Banner,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof Banner>;

export const Info: Story = {
  args: {
    tone: "info",
    icon: "ℹ",
    title: "Working offline",
    children:
      "Changes will sync when your connection returns.",
  },
};

export const Warning: Story = {
  args: {
    tone: "warning",
    icon: "⚠",
    title: "Provider degraded",
    children:
      "Resend reported elevated latency — sends will queue locally.",
    action: (
      <button type="button" className="btn btn-sm btn-secondary">
        Status page
      </button>
    ),
  },
};

export const Dismissible: Story = {
  args: {
    tone: "success",
    title: "Domain verified",
    children: "All DNS records pass — sends from acme.com are authenticated.",
    dismissLabel: "Dismiss domain verified banner",
    onDismiss: () => {
      /* no-op */
    },
  },
};

export const Danger: Story = {
  args: {
    tone: "danger",
    icon: "⛔",
    title: "Send blocked",
    children:
      "List-Unsubscribe headers are missing. Add a footer block before sending.",
    action: (
      <button type="button" className="btn btn-sm btn-primary">
        Fix footer
      </button>
    ),
  },
};
