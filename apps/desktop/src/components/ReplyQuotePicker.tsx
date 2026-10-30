/**
 * ReplyQuotePicker — contained until reader-consent and attribution controls
 * exist. A reply is private correspondence; receiving it is not permission to
 * republish its text or direct email address in a marketing campaign.
 */

import { type ReactElement } from "react";

import { Modal } from "./Modal";
import { Notice } from "./Notice";

interface Props {
  open: boolean;
  onClose: () => void;
  campaignId: string | number;
  onPick: (quote: { excerpt: string; fromEmail: string }) => void;
}

export function ReplyQuotePicker({ open, onClose }: Props): ReactElement {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reader quotes require consent"
      description="Private replies cannot be inserted into campaign content from this workspace."
    >
      <Notice tone="warning" title="Quotation is unavailable">
        Add a consent workflow, least-privilege reply access, masked identity,
        approved attribution, and an immutable publication audit before enabling
        testimonials. No reply content or sender address is loaded in this
        dialog.
      </Notice>
      <div
        style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}
      >
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Understood
        </button>
      </div>
    </Modal>
  );
}
