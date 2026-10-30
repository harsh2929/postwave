/**
 * Stories for the toast system.
 *
 * The toast queue is module-level state, so stories use a small
 * <ToastDemo /> wrapper that mounts the ToastHost and fires a
 * canonical toast on render. Each story renders one kind so a
 * snapshot captures the styling for that kind in isolation.
 *
 * Note: duration is overridden to a very large number so the toast
 * doesn't fade out mid-snapshot.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { type ReactElement, useEffect } from "react";

import { ToastHost, toast } from "../components/Toast";

interface DemoProps {
  kind: "success" | "error" | "info" | "soon";
  message: string;
  detail?: string;
  withAction?: boolean;
}

function ToastDemo({ kind, message, detail, withAction }: DemoProps): ReactElement {
  useEffect(() => {
    const payload = {
      message,
      detail,
      // Effectively no auto-dismiss inside Storybook so snapshots are stable.
      duration: 1000 * 60 * 60,
      action: withAction
        ? {
            label: "Undo",
            onClick: () => {
              /* no-op */
            },
          }
        : undefined,
    } as const;
    toast[kind](payload);
    // Re-fire on hot-reload — the queue would otherwise re-empty after
    // the host unmounts.
  }, [kind, message, detail, withAction]);
  return (
    <div style={{ minHeight: 200 }}>
      <p
        style={{
          color: "var(--pw-fg-subtle)",
          fontSize: 13,
          margin: 0,
        }}
      >
        Toast appears in the corner (rendered by ToastHost).
      </p>
      <ToastHost />
    </div>
  );
}

const meta: Meta<typeof ToastDemo> = {
  title: "Primitives/Toast",
  component: ToastDemo,
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

type Story = StoryObj<typeof ToastDemo>;

export const Success: Story = {
  args: {
    kind: "success",
    message: "Subscriber imported",
    detail: "Will appear in your audience within 30 seconds.",
  },
};

export const Error: Story = {
  args: {
    kind: "error",
    message: "Could not save changes",
    detail: "Network error — your edits are still in the form.",
  },
};

export const Info: Story = {
  args: {
    kind: "info",
    message: "DKIM verification queued",
  },
};

export const Soon: Story = {
  args: {
    kind: "soon",
    message: "Coming in v0.2",
    detail: "Bulk import from Mailchimp ships next month.",
  },
};

export const WithAction: Story = {
  args: {
    kind: "success",
    message: "Subscriber deleted",
    detail: "You can undo this for the next 6 seconds.",
    withAction: true,
  },
};
