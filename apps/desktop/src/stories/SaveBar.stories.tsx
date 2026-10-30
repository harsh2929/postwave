/**
 * Stories for the settings SaveBar.
 *
 * SaveBar is sticky-bottom-positioned in production (under
 * `.settings-savebar` CSS). Inside Storybook we render it in a
 * tall-enough wrapper so the sticky positioning has room to anchor;
 * if you collapse the canvas the bar will still pin to the bottom.
 */
import type { Meta, StoryObj } from "@storybook/react";

import { SaveBar } from "../components/settings/SaveBar";

const meta: Meta<typeof SaveBar> = {
  title: "Primitives/SaveBar",
  component: SaveBar,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    onSave: () => {
      /* no-op */
    },
    onDiscard: () => {
      /* no-op */
    },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: "60vh",
          padding: 24,
          background: "var(--pw-bg)",
          color: "var(--pw-fg)",
        }}
      >
        <h3 style={{ margin: "0 0 12px" }}>Workspace settings</h3>
        <p
          style={{
            color: "var(--pw-fg-subtle)",
            fontSize: 13,
            maxWidth: 540,
          }}
        >
          The SaveBar pins to the bottom of the settings pane whenever the
          form has unsaved changes. It also surfaces the last save error
          inline so the operator never has to scroll up to find what went
          wrong.
        </p>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof SaveBar>;

export const Dirty: Story = {
  args: {
    dirty: true,
    saving: false,
    summary: "3 unsaved changes",
  },
};

export const Saving: Story = {
  args: {
    dirty: true,
    saving: true,
    summary: "3 unsaved changes",
  },
};

export const Error: Story = {
  args: {
    dirty: true,
    saving: false,
    error: "Workspace name must be unique. Try a different value.",
    summary: "1 unsaved change",
  },
};

export const JustSaved: Story = {
  args: {
    dirty: false,
    saving: false,
    savedAt: "2026-06-08T12:00:00Z",
  },
};
