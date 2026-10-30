// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/relative-time";
import type { EditorCheckpointState } from "@/lib/use-editor-checkpoint";

/**
 * The visible half of ECO-03: what a durable draft looks like when you arrive
 * on the second device.
 *
 * Three states, deliberately distinct — collapsing them was the failure the
 * server's 409 body was designed to let a client avoid:
 *
 *   OFFER    — a draft exists that holds work the saved record does not. It is
 *              offered, never applied. A draft that appears in the fields
 *              unasked is indistinguishable from the record, and the person
 *              cannot tell what they are about to save over. In review mode
 *              the same offer becomes the precise explanation of why they can
 *              only look: the draft is real, and this surface cannot resume it.
 *   CONFLICT — another device saved newer work than the draft this one tried to
 *              write. BOTH are named; the person picks. Nothing here decides.
 *   REFUSAL  — the draft broke a rule (too large, unsupported escape, the
 *              per-account draft cap). Autosave is off until the draft changes,
 *              and saying so is the difference between "your work is safe" and
 *              a person believing it while it is not.
 */
export function DraftCheckpointBanner<T>({
  state,
  canEdit,
}: {
  state: EditorCheckpointState<T>;
  canEdit: boolean;
}) {
  const { offer, conflict, refusal } = state;
  if (!offer && !conflict && !refusal) return null;

  return (
    <div className="mb-4 space-y-3">
      {conflict ? (
        <div
          role="alert"
          data-testid="checkpoint-conflict"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          <p className="font-medium">
            Another device saved a newer draft of this campaign.
          </p>
          {conflict.current ? (
            <>
              <p className="mt-1 opacity-90">
                Theirs was checkpointed{" "}
                <RelativeTime iso={conflict.current.updated_at} />. Nothing has
                been overwritten — choose which draft to keep.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={state.useTheirs}>
                  Use the newer draft
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={state.keepMine}
                >
                  Keep what is on this device
                </Button>
              </div>
            </>
          ) : (
            <p className="mt-1 opacity-90">
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
          className="rounded-md border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-100"
        >
          <p className="font-medium">
            You have an unsaved draft from another device.
          </p>
          <p className="mt-1 opacity-90">
            Last edited <RelativeTime iso={offer.updated_at} />, after this
            campaign was last saved.
            {canEdit
              ? " Nothing has been applied yet."
              : " This campaign can no longer be edited, so the draft can only be viewed here — reopen it on the device you wrote it on, or duplicate the campaign to keep working."}
          </p>
          {canEdit ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={state.resume}>
                Resume this draft
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={state.dismiss}
              >
                Discard it and keep the saved version
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {refusal ? (
        <div
          role="alert"
          data-testid="checkpoint-refusal"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
        >
          <p className="font-medium">This draft is not being checkpointed.</p>
          <p className="mt-1 text-muted-foreground">
            {refusal} Your edits are still on this screen, but they will not
            survive closing it until you save the campaign.
          </p>
        </div>
      ) : null}
    </div>
  );
}
