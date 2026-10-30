/**
 * lib/audienceSyncRunNow.ts — exactly what the phone promises before it pushes
 * an audience at a third party, and how to read what came back.
 *
 * Free of react-native imports (lib/format is itself pure), so every sentence
 * below is asserted by a test rather than by a screenshot. Three server
 * behaviours drive all of it, and each one breaks a habit carried over from the
 * agent-routines surface:
 *
 *  1. RUN-NOW IS SYNCHRONOUS, NOT 202-AND-DETACHED. `RunSync`
 *     (sync_handlers.go:176-193) calls `Runner.RunIdempotent` INLINE and
 *     answers 200 with the CLOSED ledger row. So the response IS the outcome,
 *     there is nothing to poll for afterwards — and, critically, a FAILED run
 *     is still HTTP 200 with `status:"failed"`. A resolved promise is not a
 *     success here; `runNowResultMessage` reads the returned status instead.
 *  2. A PAUSED SYNC CANNOT BE RUN BY HAND. `beginSyncOperation`
 *     (operation_safety.go:288-290) returns `ErrLifecycleBlocked` when the sync
 *     row is not `enabled`, which the handler maps to 409
 *     `audience_operation_blocked`. This is the OPPOSITE of agent routines,
 *     where a manual run on a paused routine is deliberately allowed. The
 *     button is therefore disabled with a reason rather than offered and 409'd.
 *  3. THE CLIENT GIVES UP BEFORE THE SERVER DOES. `SyncRunTimeout` is sixty
 *     seconds (sync_runner.go:54); the mobile SDK's default per-call timeout is
 *     thirty (packages/sdk-ts/src/client.ts:190) and it retries a timeout with
 *     the SAME auto-minted `Idempotency-Key` (client.ts:399-423). Server-side
 *     that key converges on the operation already in flight
 *     (`manualOperationKey`, operation_safety.go:40) and the retry is answered
 *     with the still-`running` row rather than starting a second delivery. So
 *     "the response says running" is a NORMAL, correct outcome for a long sync,
 *     and the copy for it must not read as a fault.
 */
import { num } from "./format";

/**
 * The `Idempotency-Key` for one user-initiated run.
 *
 * Minted per ATTEMPT rather than per sync: the server hashes it into a durable
 * operation identity (`manualOperationKey`), so reusing one key across two
 * deliberate presses would silently answer the second with the first press's
 * run row. A fresh key per press means a second press either opens a genuine
 * second run or is refused with 409 `audience_operation_in_progress` — both of
 * which are true answers, where a replayed old row would not be.
 *
 * It is a retry-correlation value, never a secret and never subscriber-derived:
 * the sync id is a workspace-scoped uuid the caller already holds.
 */
export function newRunOperationKey(syncId: string): string {
  return `mobile-audience-sync-${syncId}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

export interface RunNowCopy {
  title: string;
  message: string;
  consequence: string;
  confirmLabel: string;
  destructive: boolean;
}

export interface RunNowSubject {
  name: string;
  enabled: boolean;
  schedule: string;
  destinationType: string;
  destinationLabel: string;
  sourceLabel: string;
}

/**
 * What the confirm sheet says. Every clause is a fact from the runner, not
 * reassurance:
 *
 *  - "sends real subscriber records" — `MemberRow` (syncs.go:817-823) carries
 *    email, status, tags and the consent receipt. This is personal data leaving
 *    the platform, and the sheet says so plainly.
 *  - "in batches of 500, up to 50,000" — `SyncBatchSize` / `SyncMaxRows`
 *    (sync_runner.go:44-50).
 *  - "withholds anyone who has not consented" — the activation firewall gates
 *    every member on per-purpose consent + suppression before a row leaves
 *    (sync_runner.go:85-88), and records the count as `excluded_count`.
 *  - "restarts the schedule clock" — `finishSyncOperationTx` stamps
 *    `last_run_at = now()`, and `claimDue` measures the next automatic run from
 *    it, so a manual run pushes the next scheduled one back by a full interval.
 *  - "up to a minute" — the run is inline under `SyncRunTimeout`.
 *
 * There is deliberately no undo: nothing in the API recalls a delivered batch,
 * so an "Undo" on the toast afterwards would be a lie about what it can do.
 */
export function runNowCopy(sync: RunNowSubject): RunNowCopy {
  const clauses = [
    `Moosewave will resolve this ${sync.sourceLabel.toLowerCase()} now and send real subscriber records — email, status, tags and consent — to ${sync.destinationLabel}, in batches of 500 and up to 50,000 members.`,
    "Anyone who has not consented for this purpose, or who is suppressed, is withheld and counted rather than sent.",
  ];
  if (sync.schedule.trim().toLowerCase() !== "manual") {
    clauses.push(
      "Running now also restarts the schedule clock, so the next automatic run is measured from this one.",
    );
  }
  return {
    title: `Run ${sync.name || "this sync"} now?`,
    message: clauses.join(" "),
    consequence:
      "It runs here and now, for up to a minute, and cannot be cancelled or recalled once a batch has left.",
    confirmLabel: "Run now",
    // Not destructive: it delivers data and destroys nothing. Painting it red
    // would train operators to ignore the colour where it does matter.
    destructive: false,
  };
}

/** Why the button is unavailable, or null when it is available. */
export function runNowBlockedReason(
  sync: Pick<RunNowSubject, "enabled">,
  online: boolean,
): string | null {
  if (!sync.enabled) {
    // Fact 2: the server refuses this with a 409, so the phone must not offer
    // a button whose only possible outcome is an error.
    return "This sync is paused, and the server refuses a manual run on a paused sync. Enable it on desktop first.";
  }
  if (!online) {
    return "You're offline. A run is never queued for later — releasing it hours from now would push an audience at a destination at a moment nobody chose.";
  }
  return null;
}

export interface RunNowOutcome {
  status: string;
  rowsExported: number | null;
  excludedCount: number | null;
  error: string;
}

/**
 * The toast, read off the RUN THAT CAME BACK rather than off the fact that the
 * request succeeded (fact 1). `kind` drives the haptic as well as the colour, so
 * a failed run must never thump like a success.
 */
export function runNowResultMessage(
  run: RunNowOutcome | null,
  name: string,
): { kind: "success" | "error" | "info"; message: string } {
  const label = name || "the sync";
  if (!run) {
    // The request was answered but carried no run row. A run WAS opened
    // server-side before the response was written, so claiming nothing happened
    // would be wrong in the dangerous direction.
    return {
      kind: "info",
      message: `${label} was started, but the server did not describe the run. Pull to refresh to see how it ended.`,
    };
  }
  const status = run.status.trim().toLowerCase();
  const delivered =
    run.rowsExported === null
      ? "an unrecorded number of members"
      : `${num(run.rowsExported)} ${run.rowsExported === 1 ? "member" : "members"}`;
  const withheld =
    run.excludedCount !== null && run.excludedCount > 0
      ? ` ${num(run.excludedCount)} withheld by the consent firewall.`
      : "";
  switch (status) {
    case "succeeded":
      return {
        kind: "success",
        message: `${label} delivered ${delivered}.${withheld}`,
      };
    case "partial":
      return {
        kind: "error",
        message: `${label} delivered ${delivered} and then failed, so the destination holds part of the audience. ${run.error || "No reason was recorded."}`,
      };
    case "rejected":
      return {
        kind: "error",
        message: `${label} was rejected before anything was sent: the source is larger than the 50,000-member per-run cap.`,
      };
    case "needs_reconciliation":
      return {
        kind: "error",
        message: `${label} never acknowledged an outcome after it had started sending. Check the destination by hand before running it again.`,
      };
    case "running":
      // Fact 3. This is the normal answer for a sync that outlives the client's
      // thirty-second timeout, and it is NOT a failure.
      return {
        kind: "info",
        message: `${label} is still running on the server. Pull to refresh in a moment to see how it ended.`,
      };
    case "failed":
      return {
        kind: "error",
        message: `${label} failed. ${run.error || "No reason was recorded."}`,
      };
    default:
      return {
        kind: "info",
        message: `${label} finished with a status this app does not recognise: ${run.status.trim() || "none at all"}.`,
      };
  }
}

/**
 * Failure copy for `POST /{id}/run`, branched on what the server can actually
 * answer with — every code below is one `writeRepoErr` (handlers.go:639-655) or
 * the handler itself emits.
 */
export function runNowErrorMessage(error: unknown): string {
  const bag =
    error && typeof error === "object"
      ? (error as { status?: unknown; code?: unknown; message?: unknown })
      : {};
  const code = typeof bag.code === "string" ? bag.code : "";
  const status = typeof bag.status === "number" ? bag.status : 0;
  if (code === "runner_unavailable" || status === 503) {
    return "Audience syncs are switched off on this workspace's server, so this cannot be run from here.";
  }
  if (code === "audience_operation_in_progress") {
    return "This sync is already running — either on its schedule or from another device. Wait for it to finish rather than starting a second delivery.";
  }
  if (code === "audience_operation_blocked") {
    return "The server refused: a paused sync cannot be run by hand. Enable it on desktop first.";
  }
  if (code === "audience_operation_lease_lost") {
    return "Another worker took over this run. Pull to refresh to see how it ended.";
  }
  if (code === "request_timeout") {
    // Fact 3: the SDK already retried with the same idempotency key, so nothing
    // was duplicated — but the run may well have finished after we gave up.
    return "The server took longer than this app waits. The run was not duplicated — pull to refresh to see how it ended.";
  }
  if (status === 403) {
    return "Running a sync by hand needs an editor role on this workspace.";
  }
  if (status === 404) return "That sync no longer exists.";
  if (status === 401) return "Your session expired. Sign in and try again.";
  // A status was PRESENT and zero — the "never got an HTTP answer" case. It is
  // only claimed when the key exists: an error object with no status at all
  // carries no evidence about the network, and inventing "check your
  // connection" for it would send someone to debug a working one.
  if ("status" in bag && status === 0) {
    return "The request never reached the server. Check your connection and try again.";
  }
  const message = typeof bag.message === "string" ? bag.message.trim() : "";
  return message || "Please try again.";
}
