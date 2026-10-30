import type { Meta, StoryObj } from "@storybook/react";

import { AuthLinkRecovery } from "../pages/AuthLinkRecovery";

const meta: Meta<typeof AuthLinkRecovery> = {
  title: "Auth/AuthLinkRecovery",
  component: AuthLinkRecovery,
  parameters: { layout: "fullscreen" },
  args: {
    flow: "magic",
    onRequestNewLink: () => undefined,
    onUseAnotherMethod: () => undefined,
  },
};

export default meta;

type Story = StoryObj<typeof AuthLinkRecovery>;

export const UnsupportedVersion: Story = {
  args: { reason: "unsupported_version" },
};

export const WrongDevice: Story = {
  args: { reason: "wrong_device" },
};

export const ExpiredOrUsed: Story = {
  args: { reason: "expired_or_used" },
};

export const ResetTemporaryFailure: Story = {
  args: {
    flow: "reset",
    reason: "temporary_failure",
    onRetry: () => undefined,
  },
};
