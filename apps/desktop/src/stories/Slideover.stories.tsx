/**
 * Stories for SlideoverShell — the standardized slideover chrome that
 * pairs with the `useSlideoverBehavior` hook.
 *
 * SlideoverShell wraps the hook internally, so rendering the shell here
 * is equivalent to exercising the hook + its containers in tandem. We
 * don't ship a separate hook story because the hook has no visual
 * output on its own — it manages focus + scroll lock + the dialog
 * stack registration.
 *
 * Sizes are covered as separate stories so a reviewer can compare them
 * side-by-side in the Storybook sidebar.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactElement } from "react";

import { SlideoverShell } from "../components/SlideoverShell";

const meta: Meta<typeof SlideoverShell> = {
  title: "Primitives/Slideover",
  component: SlideoverShell,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    open: true,
    onClose: () => {
      /* no-op */
    },
    title: "alice@example.com",
  },
};

export default meta;

type Story = StoryObj<typeof SlideoverShell>;

function BodyContent(): ReactElement {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <div
          style={{ fontSize: 11, color: "var(--pw-fg-subtle)", marginBottom: 4 }}
        >
          Status
        </div>
        <div style={{ fontSize: 14 }}>Active · subscribed 4 months ago</div>
      </div>
      <div>
        <div
          style={{ fontSize: 11, color: "var(--pw-fg-subtle)", marginBottom: 4 }}
        >
          Tags
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <span className="pw-tag">founder</span>
          <span className="pw-tag">paid-plan</span>
          <span className="pw-tag">us-east</span>
        </div>
      </div>
      <div>
        <div
          style={{ fontSize: 11, color: "var(--pw-fg-subtle)", marginBottom: 4 }}
        >
          Recent activity
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          <li>Opened "Q3 announcement" · 2h ago</li>
          <li>Clicked link in "Beta invite" · 1d ago</li>
          <li>Joined list "Founders" · 4mo ago</li>
        </ul>
      </div>
    </div>
  );
}

export const Medium: Story = {
  args: {
    size: "md",
    eyebrow: "Subscriber",
    title: "alice@example.com",
    subtitle: "Tagged founder · joined 4 months ago",
    footer: (
      <>
        <button type="button" className="btn">
          Close
        </button>
        <button type="button" className="btn btn-primary">
          Save
        </button>
      </>
    ),
    children: <BodyContent />,
  },
};

export const Large: Story = {
  args: {
    size: "lg",
    eyebrow: "Campaign",
    title: "Q3 product update",
    subtitle: "Sent 4 hours ago · 14,231 recipients",
    children: <BodyContent />,
  },
};

export const Small: Story = {
  args: {
    size: "sm",
    title: "Filters",
    children: <BodyContent />,
  },
};
