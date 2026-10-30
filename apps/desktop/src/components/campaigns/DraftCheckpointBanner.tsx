/**
 * DraftCheckpointBanner — the visible half of ECO-03 on desktop: what a durable
 * draft looks like when you arrive on the second device.
 *
 * Four states, deliberately distinct. Collapsing any pair of them is the exact
 * failure the server's 409 body and its two separate codes were designed to let
 * a client avoid:
 *
 *   OFFER    — a draft exists holding work the saved record does not. It is
 *              offered, never applied: a draft that appears in the fields
 *              unasked is indistinguishable from the record, and the person
 *              cannot tell what they are about to save over. When this window
 *              cannot open the draft (review mode, or a block-composed body
 *              this HTML editor cannot represent) the resume affordance is
 *              replaced by the precise reason, which is the second half of the
 *              program's completion clause.
 *   CONFLICT — another device saved newer work than the draft this one tried to
 *              write. BOTH are named; the person picks. Nothing here decides.
 *   REFUSAL  — the draft broke a rule (too large, unsupported escape, the
 *              per-account draft cap). Autosave is off until the draft changes,
 *              and saying so is the difference between "your work is safe" and
 *              a person believing it while it is not.
 *   UNSUPPORTED — this window is signed in with an API key, and the checkpoint
 *              routes are session-only. Distinct from REFUSAL because nothing
 *              about the draft is wrong and no edit to it will help.
 */

import { type ReactElement } from "react";

import { fmtRelative } from "../../lib/format-date";
import type { EditorCheckpointState } from "../../lib/use-editor-checkpoint";

import "../../styles-draft-checkpoint.css";

export function DraftCheckpointBanner<T>({
  state,
  canEdit,
  busy = false,
}: {
  state: EditorCheckpointState<T>;
  canEdit: boolean;
  /**
   * A campaign save or audience freeze is in flight.
   *
   * `useCampaignEditorController` refuses `openEdit` and `setDraft` while
   * either runs, so a Resume pressed now would clear the offer and apply
   * nothing — the person would watch their other device's draft vanish into no
   * editor at all. Disabled is the honest state; hiding the buttons would read
   * as "the draft is gone".
   */
  busy?: boolean;
}): ReactElement | null {
  const { offer, offerBlockedReason, conflict, refusal, unsupported } = state;
  if (!offer && !conflict && !refusal && !unsupported) return null;

  return (
    <div className="draft-checkpoint-stack">
      {conflict ? (
        <div
          role="alert"
          data-testid="checkpoint-conflict"
          className="draft-checkpoint draft-checkpoint--conflict"
        >
          <p className="draft-checkpoint-title">
            Another device saved a newer draft of this campaign.
          </p>
          {conflict.current ? (
            <>
              <p className="draft-checkpoint-body">
                Theirs was checkpointed {fmtRelative(conflict.current.updated_at)}
                . Nothing has been overwritten — choose which draft to keep.
              </p>
              {conflict.blockedReason ? (
                <p className="draft-checkpoint-body">
                  {conflict.blockedReason} You can still keep what is on this
                  device.
                </p>
              ) : null}
              <div className="draft-checkpoint-actions">
                {conflict.blockedReason ? null : (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={state.useTheirs}
                    disabled={busy}
                  >
                    Use the newer draft
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={state.keepMine}
                  disabled={busy}
                >
                  Keep what is on this device
                </button>
              </div>
            </>
          ) : (
            <p className="draft-checkpoint-body">
              We could not read the newer draft to show it to you, so nothing on
              this screen has been changed and nothing has been overwritten.
              Reopen this campaign to load it.
            </p>
          )}
        </div>
      ) : null}

      {offer ? (
        <div
          role="status"
          data-testid="checkpoint-offer"
          className="draft-checkpoint draft-checkpoint--offer"
        >
          <p className="draft-checkpoint-title">
            You have an unsaved draft from another device.
          </p>
          <p className="draft-checkpoint-body">
            Last edited {fmtRelative(offer.updated_at)}, after this campaign was
            last saved.
            {canEdit && !offerBlockedReason
              ? " Nothing has been applied yet."
              : null}
          </p>
          {offerBlockedReason ? (
            <p className="draft-checkpoint-body">{offerBlockedReason}</p>
          ) : canEdit ? null : (
            <p className="draft-checkpoint-body">
              This campaign can no longer be edited here, so the draft can only
              be viewed — reopen it on the device you wrote it on, or duplicate
              the campaign to keep working.
            </p>
          )}
          {canEdit && !offerBlockedReason ? (
            <div className="draft-checkpoint-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={state.resume}
                disabled={busy}
              >
                Resume this draft
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={state.dismiss}
                disabled={busy}
              >
                Discard it and keep the saved version
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {refusal ? (
        <div
          role="alert"
          data-testid="checkpoint-refusal"
          className="draft-checkpoint draft-checkpoint--refusal"
        >
          <p className="draft-checkpoint-title">
            This draft is not being checkpointed.
          </p>
          <p className="draft-checkpoint-body">
            {refusal} Your edits are still on this screen, but they will not
            survive closing it until you save the campaign.
          </p>
        </div>
      ) : null}

      {unsupported ? (
        <div
          role="status"
          data-testid="checkpoint-unsupported"
          className="draft-checkpoint"
        >
          <p className="draft-checkpoint-title">
            Cross-device drafts are off in this window.
          </p>
          <p className="draft-checkpoint-body">
            {unsupported} Save the campaign before closing this window.
          </p>
        </div>
      ) : null}
    </div>
  );
}
