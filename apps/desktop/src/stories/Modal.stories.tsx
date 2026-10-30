/**
 * Stories for the base Modal primitive.
 *
 * Each story renders the modal already-open (no "Open" button to
 * click) so the Playwright visual-regression workflow captures the
 * full chrome immediately on page load. The `onClose` handler is a
 * no-op for the same reason — interaction is out of scope for the
 * snapshot harness.
 *
 * Rendering an open dialog inside Storybook's iframe works because
 * Modal uses `position: fixed; inset: 0` for its backdrop and the
 * iframe acts as the viewport.
 */
import type { Meta, StoryObj } from "@storybook/react";

import { Modal, ModalFooter } from "../components/Modal";

const meta: Meta<typeof Modal> = {
  title: "Primitives/Modal",
  component: Modal,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    open: true,
    onClose: () => {
      /* no-op for snapshot stories */
    },
    title: "New campaign",
  },
};

export default meta;

type Story = StoryObj<typeof Modal>;

export const Plain: Story = {
  args: {
    title: "Rename audience",
    description: "Update the display name shown across the dashboard.",
    children: (
      <>
        <p style={{ margin: 0, color: "var(--pw-fg-muted)", fontSize: 13 }}>
          Pick a short, descriptive name. You can change this any time.
        </p>
        <input
          type="text"
          defaultValue="Q3 Founders"
          style={{ marginTop: 12, width: "100%" }}
        />
        <ModalFooter>
          <button type="button" className="btn">
            Cancel
          </button>
          <button type="button" className="btn btn-primary">
            Save
          </button>
        </ModalFooter>
      </>
    ),
  },
};

export const NoDescription: Story = {
  args: {
    title: "Heads up",
    children: (
      <>
        <p style={{ margin: 0, fontSize: 13 }}>
          Your draft has unsaved changes. Continuing will discard them.
        </p>
        <ModalFooter>
          <button type="button" className="btn">
            Stay
          </button>
          <button type="button" className="btn btn-danger">
            Discard
          </button>
        </ModalFooter>
      </>
    ),
  },
};
