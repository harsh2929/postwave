/**
 * smsThreadCopy — the PURE half of the SMS thread screen.
 *
 * `app/(tabs)/sms/[phone].tsx` is the React half: hooks, refs, the FlatList,
 * the composer. Everything it needs to DECIDE — why sending is locked, which
 * sentence a failed dispatch earns, how fresh the loaded page set is — lives
 * here, with no react, react-native or expo import anywhere in the module. That
 * is what makes these rules exercisable in the node vitest environment instead
 * of only through a rendered screen, and it is the same split
 * `src/api/eventBus.ts` uses for `eventBusStream.ts`.
 *
 * THE RULE THESE FUNCTIONS SHARE: never say more than the app actually knows.
 * An unresolved reply hold describes itself without naming the other identity;
 * a 5xx is reported as an UNCONFIRMED outcome rather than a failure, because
 * the message may well have been sent.
 */
import { dateTime } from "@/lib/format";
import type { SmsReplyIntentInspection } from "@/lib/smsReplyIntentStore";

/**
 * Why the encrypted reply-recovery record forbids sending, or null.
 *
 * A storage error outranks everything: if the hold cannot be read or written,
 * the app cannot prove a previous reply was resolved, so it must not send.
 */
export function smsReplyIntentReason(input: {
  storageError: string | null;
  loading: boolean;
  inspection: SmsReplyIntentInspection;
}): string | null {
  if (input.storageError !== null) return input.storageError;
  if (input.loading) return "Checking encrypted reply recovery…";
  switch (input.inspection.status) {
    case "other_identity":
      return "A different workspace identity has an unresolved mobile reply. No identity or message details are available here, and no new reply can be sent.";
    case "other_thread":
      return "Another conversation has an unresolved mobile reply. No new reply can be sent.";
    case "current":
      return input.inspection.record.state === "reconciliation_required"
        ? "Provider dispatch is reconciling. Do not retry this held reply."
        : "Delivery outcome is unresolved. This reply remains held until the server can provide authoritative replay evidence. Do not retry.";
    default:
      return null;
  }
}

/**
 * The single sentence under the composer, in priority order: an unresolved
 * hold, then a consent/suppression block, then the choice the operator still
 * owes us. A sender or list is only "unchosen" when more than one is offered —
 * the screen auto-selects the sole candidate.
 */
export function smsReplySelectionReason(input: {
  intentReason: string | null;
  blockReason: string | null;
  senderId: string;
  senderCount: number;
  listId: string;
  listCount: number;
}): string | null {
  if (input.intentReason !== null) return input.intentReason;
  if (input.blockReason !== null) return input.blockReason;
  if (!input.senderId && input.senderCount > 1) {
    return "Choose the sender that received this conversation";
  }
  if (!input.listId && input.listCount > 1) {
    return "Choose the opted-in list authorizing this reply";
  }
  return null;
}

/**
 * The toast for a reply that failed AFTER the network call started.
 *
 * Three honest outcomes, in order:
 *   1. The hold could not be cleared — sending stays locked, and the sentence
 *      says so rather than inviting a retry.
 *   2. A definitive pre-provider refusal whose hold WAS retired — nothing was
 *      sent, and the operator can safely try again.
 *   3. Anything else. A 4xx carries the server's own message; everything else
 *      (5xx, transport loss) is reported as UNCONFIRMED, because the reply may
 *      have been dispatched and a retry could double-send.
 */
export function smsReplyFailureCopy(input: {
  error: unknown;
  holdRetired: boolean;
  holdCleanupFailed: boolean;
}): { kind: "warning" | "error"; message: string } {
  const { error } = input;
  if (input.holdCleanupFailed) {
    return {
      kind: "warning",
      message:
        "Nothing was sent, but local safety cleanup failed. Sending remains locked.",
    };
  }
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (code === "sms_reply_dispatch_release_held" && input.holdRetired) {
    return {
      kind: "error",
      message:
        "Live SMS reply dispatch is release-held before provider dispatch. Nothing was sent.",
    };
  }
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : 0;
  if (status >= 400 && status < 500 && error instanceof Error) {
    return { kind: "error", message: error.message };
  }
  return {
    kind: "error",
    message:
      "Delivery outcome is not confirmed. Keep this draft; the encrypted reply hold remains and no retry is available.",
  };
}

/**
 * The freshness line above the thread.
 *
 * Offline outranks every other state, because a stale page set the operator
 * cannot refresh is the one thing that must never read as current. A loaded
 * history window pauses automatic refresh (`restart_required`) and says so.
 */
export function smsThreadFreshnessText(input: {
  online: boolean;
  fetching: boolean;
  refreshFailed: boolean;
  restartRequired: boolean;
  snapshotAt: string | null;
  partial: boolean;
}): string {
  const { snapshotAt } = input;
  if (!input.online) {
    return `Offline · showing the last verified page set${snapshotAt ? ` · response cutoff ${dateTime(snapshotAt)}` : ""}`;
  }
  if (input.refreshFailed && snapshotAt) {
    return `Automatic refresh failed · showing the last verified page set · response cutoff ${dateTime(snapshotAt)}`;
  }
  if (input.restartRequired) {
    return `Loaded message history preserved · automatic refresh paused · pull to refresh to restart at the latest response cutoff${snapshotAt ? ` · current cutoff ${dateTime(snapshotAt)}` : ""}`;
  }
  if (input.fetching) return "Restarting at the latest response cutoff…";
  if (snapshotAt) {
    return `Response cutoff ${dateTime(snapshotAt)}${input.partial ? " · older messages available" : " · no older-page cursor returned; newer writes may still exist"}`;
  }
  return "Waiting for a verified response…";
}
