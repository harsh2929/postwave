/**
 * lib/audienceSyncDelete.ts — retiring a sync from the phone: what the confirm
 * sheet promises, when the button must not be offered at all, and how to read
 * the four distinct refusals the server can answer with.
 *
 * WHY THIS VERB IS ON A PHONE AT ALL, when api/audienceSyncs.ts once recorded
 * the opposite. That note ("not a thing anyone needs to do from a phone") was
 * written about AUTHORING — create/edit/delete as one desk-bound family. The
 * parity register separates them, and it is right to: create and edit are the
 * STARTING half (an HTTPS receiver, an HMAC secret, nine validation shapes),
 * while delete is the STOPPING half — it removes authority from a sync that is
 * pushing subscriber records somewhere it should not. `lib/stoppingHalfPolicy`
 * settles that shape for the whole app: the half that REMOVES authority ships
 * to the phone even when the half that grants it does not. Pausing needs
 * PATCH — the masked-config write path this client deliberately does not have
 * — so on mobile "stop this for good" is the only stop available.
 *
 * THREE SERVER FACTS DRIVE EVERY SENTENCE BELOW.
 *
 *  1. IT CASCADES, AND NOTHING RESTORES IT. `DeleteSyncIfCurrent`
 *     (syncs.go:685) deletes the `audience_syncs` row; runs cascade via FK, so
 *     the whole run ledger — every exclusion receipt, every provider message —
 *     goes with it. There is no undelete route anywhere in the API. The confirm
 *     sheet says this, and no toast offers an undo.
 *  2. A RUN IN FLIGHT BLOCKS IT, WITH OR WITHOUT If-Match. The DELETE carries
 *     `AND NOT COALESCE(run_lease_expires_at > now(), false)` (syncs.go:713),
 *     so a sync mid-delivery is refused with 409 rather than yanked out from
 *     under the runner. That refusal is a normal outcome, not a fault, and it
 *     reads that way.
 *  3. If-Match IS OPTIONAL AND WE DO NOT SEND ONE. `optionalAudienceIfMatch`
 *     (handlers.go:682-695) accepts an ABSENT header, and the LIST response
 *     this screen holds carries no per-row ETag — only `GET /{id}` sets one.
 *     Minting a token from `updated_at` client-side would be inventing a
 *     validator the server never issued; a wrong guess reads as 412 and a right
 *     one is the same request without the header. Fact 2's lease check is the
 *     protection that actually matters here, and it applies either way.
 *
 * No react-native import (lib/format is itself pure), so every sentence is
 * asserted by a node test rather than by a screenshot.
 */

export interface DeleteSyncCopy {
  title: string;
  message: string;
  consequence: string;
  confirmLabel: string;
  destructive: boolean;
}

export interface DeleteSyncSubject {
  name: string;
  destinationLabel: string;
  sourceLabel: string;
  /** Runs the ledger holds for this sync, when the history has been read. */
  runCount: number | null;
}

/**
 * What the confirm sheet says. Fact 1 is the whole message: the cascade is the
 * part a reader cannot see from the row they are looking at.
 */
export function deleteSyncCopy(sync: DeleteSyncSubject): DeleteSyncCopy {
  const ledger =
    sync.runCount === null
      ? "Its run history goes with it"
      : sync.runCount === 1
        ? "Its one recorded run goes with it"
        : `Its ${sync.runCount} recorded runs go with them`;
  return {
    title: `Delete ${sync.name || "this sync"}?`,
    message: `Nothing more will be pushed from this ${sync.sourceLabel.toLowerCase()} to ${sync.destinationLabel}, on a schedule or by hand. ${ledger} — every run's outcome, provider message and consent-exclusion receipt is deleted with the sync.`,
    consequence:
      "There is no undo: the API has no route that restores a deleted sync, and the records already delivered to the destination stay where they are.",
    confirmLabel: "Delete sync",
    destructive: true,
  };
}

/** Why the button must not be pressable, or null when it may be. */
export function deleteSyncBlockedReason(online: boolean): string | null {
  if (!online) {
    // Never queued: a delete released from an offline queue hours later would
    // destroy a run ledger at a moment nobody chose, and would race whatever
    // was done at a desk in between.
    return "You're offline. Deleting a sync is never queued and released later — reconnect and try again.";
  }
  return null;
}

/** The toast after a delete the server accepted (204, no body). */
export function deleteSyncSuccessMessage(name: string): string {
  return `${name || "The sync"} is deleted. Nothing further will be pushed to its destination.`;
}

/**
 * Failure copy, branched on what this route can actually answer with: every
 * code below is one `writeRepoErr` emits (handlers.go:659-677) or is the
 * precondition writer's.
 */
export function deleteSyncErrorMessage(error: unknown): string {
  const bag =
    error && typeof error === "object"
      ? (error as { status?: unknown; code?: unknown; message?: unknown })
      : {};
  const code = typeof bag.code === "string" ? bag.code : "";
  const status = typeof bag.status === "number" ? bag.status : 0;
  if (code === "audience_operation_in_progress" || status === 409) {
    // Fact 2. Not a fault — the runner is mid-delivery and the row is held.
    return "This sync is running right now, so it can't be deleted yet. Wait for the run to finish and try again.";
  }
  if (status === 412) {
    return "Someone changed this sync while you were looking at it. Pull to refresh and try again.";
  }
  if (status === 403) {
    return "Deleting a sync needs an editor role on this workspace.";
  }
  if (status === 404) {
    // Already gone is the outcome that was wanted; saying "failed" would send
    // someone to look for a sync that no longer exists.
    return "That sync is already gone.";
  }
  if (status === 401) return "Your session expired. Sign in and try again.";
  if ("status" in bag && status === 0) {
    return "The request never reached the server, so nothing was deleted. Check your connection and try again.";
  }
  const message = typeof bag.message === "string" ? bag.message.trim() : "";
  return message || "The sync could not be deleted. Please try again.";
}

/**
 * True when a 404 should be treated as "the delete achieved what it was for".
 * The caller still refreshes the list either way; this only decides whether the
 * toast is red.
 */
export function deleteAlreadyGone(error: unknown): boolean {
  const bag = error && typeof error === "object" ? (error as { status?: unknown }) : {};
  return typeof bag.status === "number" && bag.status === 404;
}
