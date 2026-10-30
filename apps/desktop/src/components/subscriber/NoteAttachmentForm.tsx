/**
 * Honest attachment-creation gate for subscriber notes.
 *
 * Moosewave does not yet expose an upload session that binds an object to the
 * tenant, verifies the uploaded bytes, and releases the object after scanning.
 * Rendering a file picker or accepting an object-store key would therefore
 * imply an upload that this client cannot complete safely. Keep the action
 * discoverable, but natively disabled and accompanied by a visible reason.
 */

import { type ReactElement, useId } from "react";

export const NOTE_ATTACHMENT_UPLOAD_UNAVAILABLE_REASON =
  "Secure note uploads are unavailable until Moosewave can verify object ownership and scan the uploaded bytes. Existing authorized attachments remain readable.";

interface Props {
  reason?: string;
}

export function NoteAttachmentForm({
  reason = NOTE_ATTACHMENT_UPLOAD_UNAVAILABLE_REASON,
}: Props): ReactElement {
  const reasonId = useId();

  return (
    <div className="note-attach-form note-attach-unavailable">
      <button
        type="button"
        className="btn btn-xs btn-ghost note-attach-trigger"
        disabled
        aria-describedby={reasonId}
      >
        + Attach file · Unavailable
      </button>
      <span id={reasonId} className="muted small" role="note">
        {reason}
      </span>
    </div>
  );
}
