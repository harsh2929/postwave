/**
 * Stories for ConfirmModal — the standard "are you sure?" prompt.
 *
 * Three flavors are covered:
 *   - Plain confirm (just title + body)
 *   - Danger styled (red primary button)
 *   - Type-to-confirm (irreversible destructive op)
 *
 * The component owns its own typed-input state so the type-to-confirm
 * story starts with an empty input and a disabled Confirm button,
 * which is exactly how the production UX looks at first glance.
 */
import type { Meta, StoryObj } from "@storybook/react";

import { ConfirmModal } from "../components/ConfirmModal";

const meta: Meta<typeof ConfirmModal> = {
  title: "Primitives/ConfirmModal",
  component: ConfirmModal,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    open: true,
    onClose: () => {
      /* no-op */
    },
    onConfirm: () => {
      /* no-op */
    },
  },
};

export default meta;

type Story = StoryObj<typeof ConfirmModal>;

export const Plain: Story = {
  args: {
    title: "Send test email?",
    description: "We'll send a copy to your own address.",
    confirmLabel: "Send test",
  },
};

export const Destructive: Story = {
  args: {
    title: "Delete sequence",
    description: "Subscribers currently in this sequence will stop receiving emails.",
    confirmLabel: "Delete sequence",
    danger: true,
  },
};

export const TypeToConfirm: Story = {
  args: {
    title: "Delete workspace",
    description:
      "This action is irreversible. All subscribers, campaigns, and analytics will be permanently removed.",
    confirmLabel: "Delete workspace forever",
    danger: true,
    typeToConfirm: "delete my workspace",
  },
};

export const Busy: Story = {
  args: {
    title: "Revoke API token",
    description: "The token will stop working immediately.",
    confirmLabel: "Revoke",
    danger: true,
    busy: true,
  },
};
