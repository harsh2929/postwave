// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The fixture every replay engine must satisfy.
 *
 * Three engines replay offline queues — web, desktop, and mobile's separate
 * implementation — and each decides independently what to do when a replay
 * fails, conflicts, or targets a record that has since been deleted. Three
 * independent decisions about one queue is the shape this repo keeps
 * producing, and the shared helpers in this package only fix HALF of it: they
 * make the rule single-sourced, but nothing checks that an engine CALLS the
 * rule correctly, or that it does the right thing with the answer.
 *
 * That gap is not hypothetical. `isSuppressedByTombstone` reads `resource` and
 * `queuedAt`; an engine that passes a mutation missing either one gets `false`
 * for every input and silently loses the entire protection, while this
 * package's own unit tests stay green because they call the function directly
 * with well-formed arguments.
 *
 * So this file deliberately does NOT test the rules. It enumerates cases and
 * scenarios for an engine's own test to run THROUGH ITS REAL REPLAY PATH.
 * Adding an entry here obliges every engine.
 *
 * WHY THIS IS A SOURCE FILE, NOT A `.test.ts`. It was a test file, and that is
 * exactly why it had no consumers: test files are not compiled into `dist`, so
 * no other package could import it even in principle. A conformance fixture
 * that cannot be imported is decoration.
 *
 * WHY EVERY TIMESTAMP IS RELATIVE. The queues are TTL-bounded — web discards
 * anything older than four hours and marks it "no longer replayable" before the
 * tombstone rule is ever consulted. A fixture with absolute dates therefore
 * stops exercising suppression the moment it ages out of the window, and does
 * it SILENTLY: the expectations still pass, for the wrong reason, because a
 * dropped-as-expired item and a dropped-as-suppressed item are both just
 * "gone". Offsets from a caller-supplied `now` keep every fixture permanently
 * inside the window.
 *
 * WHY THE RESOURCE IS A PARAMETER. Each engine allowlists which mutations may
 * be queued AT ALL, and the lists differ by surface — web queues only forms and
 * segments; desktop additionally queues subscribers, campaigns, templates,
 * tags. A fixture hard-coding one resource is silently REWRITTEN by the engines
 * that do not queue it (web's store replaces the status with `failed` and drops
 * `resource`), and the resulting assertions pass against a mangled item. That
 * is not a hypothetical either: it is what the first draft of this fixture did,
 * and the seeding guard only compared queue LENGTH, which was still correct.
 * Each engine binds these shapes to paths it genuinely accepts and skips the
 * shapes it cannot express, via `partitionByShape` — which makes each engine
 * declare the EXACT set it skipped, so a shape silently dropping out of a suite
 * fails rather than shrinking the suite.
 *
 * WHAT NO ENGINE COVERS, stated because a conformance fixture that hides its
 * own holes is worse than none. No surface's allowlist admits a DELETE, a
 * record-targeted POST, or a sub-resource path, so `record-delete`,
 * `record-post` and `sub-resource-patch` run on ZERO engines — and two of those
 * are `suppressed: true` cases. Exactly ONE positive-suppression case reaches a
 * real replay path. The sub-resource resurrection and the redundant-DELETE
 * paths are exercised only by direct calls in tombstone-conformance.test.ts,
 * which is precisely the mode this header calls insufficient. They are kept
 * here because the rule must still be right about them, and because the day a
 * surface starts queueing DELETEs the case is already written.
 */

import type { OfflineMutationCore } from "./index.js";
import type { Tombstone, TombstoneCandidate } from "./tombstone.js";

const MINUTE = 60_000;

/** ISO-8601 for `n` minutes before `now`. */
export function minutesAgo(n: number, now: number = Date.now()): string {
  return new Date(now - n * MINUTE).toISOString();
}

/**
 * Which resources an engine's queue actually accepts.
 *
 * `otherResource` must be a DIFFERENT type the engine also accepts: it carries
 * the cross-type suppression case and the independent-bucket case, both of
 * which are meaningless if the two resources collapse to one.
 */
export interface ConformanceBinding {
  resource: string;
  otherResource: string;
}

/** Sensible default for an engine with no allowlist of its own. */
export const DEFAULT_BINDING: ConformanceBinding = {
  resource: "subscribers",
  otherResource: "campaigns",
};

const collection = (resource: string) => `/api/v1/${resource}`;
const record = (resource: string, id: string) => `/api/v1/${resource}/${id}`;

/* -------------------------------------------------------------------------- */
/* Tombstone suppression                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The request shapes a suppression case can take.
 *
 * Named so an engine that cannot queue a shape (web queues no DELETE, and no
 * sub-resource path) reports WHICH cases it skipped instead of quietly running
 * a smaller suite than it appears to.
 */
export type ConformanceShape =
  | "record-patch"
  | "record-post"
  | "record-delete"
  | "sub-resource-patch"
  | "collection-post"
  | "cross-type-patch";

export interface ConformanceCase {
  name: string;
  shape: ConformanceShape;
  tombstones: Tombstone[];
  mutation: TombstoneCandidate;
  /** True when the engine must DROP this mutation rather than send it. */
  suppressed: boolean;
  why: string;
}

/**
 * The suppression cases, anchored to `now` and bound to an engine's resources.
 *
 * A function rather than a constant so each engine gets timestamps inside its
 * own queue's TTL, against paths its own allowlist accepts.
 */
export function conformanceCases(
  now: number = Date.now(),
  binding: ConformanceBinding = DEFAULT_BINDING,
): ConformanceCase[] {
  const { resource, otherResource } = binding;
  // The deletion happened an hour ago. "Earlier" mutations were queued two
  // hours ago — before it — and "later" ones half an hour ago, after it.
  const deletedAt = minutesAgo(60, now);
  const EARLIER = minutesAgo(120, now);
  const LATER = minutesAgo(30, now);
  const ONE = `${resource}-1`;
  const TWO = `${resource}-2`;
  const deleted: Tombstone[] = [{ resource, id: ONE, deletedAt }];

  return [
    {
      name: "edit queued before a delete on another device",
      shape: "record-patch",
      tombstones: deleted,
      mutation: { method: "PATCH", path: record(resource, ONE), resource, queuedAt: EARLIER },
      suppressed: true,
      why: "the deletion the user watched succeed must not be undone by a device they were not looking at",
    },
    {
      name: "edit queued after the delete",
      shape: "record-patch",
      tombstones: deleted,
      mutation: { method: "PATCH", path: record(resource, ONE), resource, queuedAt: LATER },
      suppressed: false,
      why:
        "an intent newer than the deletion is not stale; dropping it discards work " +
        "the user is looking straight at, which is the mirror failure",
    },
    {
      name: "deliberate recreation after the delete",
      shape: "record-post",
      tombstones: deleted,
      mutation: { method: "POST", path: record(resource, ONE), resource, queuedAt: LATER },
      suppressed: false,
      why: "a create newer than the deletion is a recreation, not a resurrection",
    },
    {
      name: "nested write under the deleted record",
      shape: "sub-resource-patch",
      tombstones: deleted,
      mutation: { method: "PATCH", path: `${record(resource, ONE)}/tags`, resource, queuedAt: EARLIER },
      suppressed: true,
      why: "recreating through a sub-resource is the same resurrection by a longer path",
    },
    {
      name: "a different record of the same type",
      shape: "record-patch",
      tombstones: deleted,
      mutation: { method: "PATCH", path: record(resource, TWO), resource, queuedAt: EARLIER },
      suppressed: false,
      why: "suppressing an unrelated record would silently discard someone's real edit",
    },
    {
      name: "collection-level create",
      shape: "collection-post",
      tombstones: deleted,
      mutation: { method: "POST", path: collection(resource), resource, queuedAt: EARLIER },
      suppressed: false,
      why: "a collection write cannot be the deleted record; suppressing it drops a new signup",
    },
    {
      name: "redundant delete of an already-deleted record",
      shape: "record-delete",
      tombstones: deleted,
      mutation: { method: "DELETE", path: record(resource, ONE), resource, queuedAt: EARLIER },
      suppressed: true,
      why: "replaying it 404s and surfaces as a sync error for something that went exactly as the user wanted",
    },
    {
      name: "same id, different resource type",
      shape: "cross-type-patch",
      tombstones: deleted,
      mutation: {
        method: "PATCH",
        path: record(otherResource, ONE),
        resource: otherResource,
        queuedAt: EARLIER,
      },
      suppressed: false,
      why: "ids are only unique within a type; matching across types would drop unrelated work",
    },
  ];
}


/**
 * Split the cases into the ones an engine can actually queue and the ones it
 * cannot, so a suite can DECLARE its skips instead of silently running fewer
 * cases than it appears to.
 *
 * `canQueue` is the engine's own allowlist predicate — the same one its store
 * uses — because the alternative is a second, hand-maintained opinion in the
 * test about what the engine accepts, which is the drift this package exists
 * to remove.
 */
export function partitionByShape(
  cases: ConformanceCase[],
  canQueue: (method: string, path: string) => boolean,
): { runnable: ConformanceCase[]; skippedShapes: ConformanceShape[] } {
  const runnable: ConformanceCase[] = [];
  const skipped = new Set<ConformanceShape>();
  for (const c of cases) {
    if (canQueue(c.mutation.method, c.mutation.path)) runnable.push(c);
    else skipped.add(c.shape);
  }
  return { runnable, skippedShapes: [...skipped].sort() };
}

/**
 * The shapes no surface's mutation allowlist admits today.
 *
 * Asserted by every engine's suite, so this stops being true LOUDLY: a surface
 * that starts queueing DELETEs fails the assertion and gets the case for free,
 * and a surface that quietly stops queueing something fails it too.
 */
export const SHAPES_NO_ENGINE_QUEUES: ConformanceShape[] = [
  "record-delete",
  "record-post",
  "sub-resource-patch",
];

/* -------------------------------------------------------------------------- */
/* Injected replay failure                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What the injected replay does for a given item.
 *
 * `throw` is distinct from `failed` on purpose. An engine that only handles the
 * returned union treats a thrown network error as an unhandled rejection, which
 * inside a `Promise.all` fan-out rejects the whole drain — every OTHER resource
 * bucket is abandoned mid-pass because one request threw. That is a few
 * characters of difference in the engine and a total difference in behaviour,
 * and no test that only returns values can see it.
 */
export type InjectedOutcome = "replayed" | "conflict" | "failed" | "throw";

export interface FailureScenario {
  name: string;
  /** Seeded into the engine's queue, in order. */
  queue: OfflineMutationCore[];
  /** Deletions visible to the engine during the drain. */
  tombstones: Tombstone[];
  /** What replay does per item id. Absent ⇒ "replayed". */
  script: Record<string, InjectedOutcome>;
  expect: {
    replayed: number;
    conflicts: number;
    failed: number;
    suppressed: number;
    /**
     * EXACTLY the ids the engine called replay for, in any order.
     *
     * Exact, not "these were not attempted". A not-attempted list has almost no
     * detection power here and that was measured, not assumed: deleting the
     * harness's own `attempted.push` made every such assertion vacuously true
     * and BOTH engines stayed fully green, because an unscripted extra attempt
     * also increments `replayed` and the totals assertion fires first. Two
     * scenarios had an empty list, so their loop was a no-op outright.
     *
     * An exact set is independent of the totals: it catches an item attempted
     * that should not have been, an item skipped that should have been sent,
     * a broken harness, and — the case totals can never see — an engine that
     * replays one item SEVERAL times. Desktop retries in-drain up to
     * OUTBOX_MAX_ATTEMPTS, so a single item can legitimately produce many
     * calls; nothing observed that before.
     */
    attempted: string[];
  };
  why: string;
}

/** Minimal well-formed queue item; each engine spreads its own extra fields on. */
export function conformanceItem(
  over: Partial<OfflineMutationCore> & Pick<OfflineMutationCore, "id">,
  now: number = Date.now(),
  binding: ConformanceBinding = DEFAULT_BINDING,
): OfflineMutationCore {
  return {
    method: "PATCH",
    path: record(binding.resource, over.id),
    idempotencyKey: `idem-${over.id}`,
    queuedAt: minutesAgo(120, now),
    attempts: 0,
    status: "pending",
    resource: binding.resource,
    ...over,
  };
}

/**
 * The injected-failure scenarios, anchored to `now` and bound to an engine's
 * resources.
 *
 * Each seeds a queue, scripts what replay does, and states both the totals and
 * — crucially — which items must never have been sent.
 */
export function failureScenarios(
  now: number = Date.now(),
  binding: ConformanceBinding = DEFAULT_BINDING,
): FailureScenario[] {
  const { resource, otherResource } = binding;
  const it = (over: Partial<OfflineMutationCore> & Pick<OfflineMutationCore, "id">) =>
    conformanceItem(over, now, binding);
  const none: Tombstone[] = [];
  const ONE = `${resource}-1`;
  const TWO = `${resource}-2`;
  const oneDeleted: Tombstone[] = [
    { resource, id: ONE, deletedAt: minutesAgo(60, now) },
  ];
  const other = {
    resource: otherResource,
    path: record(otherResource, `${otherResource}-1`),
  };

  return [
    {
      name: "a transient failure parks the rest of its own bucket",
      queue: [it({ id: "a" }), it({ id: "b" })],
      tombstones: none,
      script: { a: "failed" },
      expect: { replayed: 0, conflicts: 0, failed: 1, suppressed: 0, attempted: ["a"] },
      why:
        "replaying b over a failed a reorders two edits to the same resource; the " +
        "later write wins and the user's earlier change is silently lost",
    },
    {
      name: "a thrown error is caught and parks the bucket, like a returned failure",
      queue: [it({ id: "a" }), it({ id: "b" })],
      tombstones: none,
      script: { a: "throw" },
      expect: { replayed: 0, conflicts: 0, failed: 1, suppressed: 0, attempted: ["a"] },
      why:
        "an uncaught throw inside the per-bucket loop rejects the whole drain, " +
        "abandoning every unrelated bucket mid-pass",
    },
    {
      name: "one bucket's failure does not stop an unrelated resource",
      queue: [it({ id: "a" }), it({ id: "c", ...other })],
      tombstones: none,
      script: { a: "failed" },
      expect: { replayed: 1, conflicts: 0, failed: 1, suppressed: 0, attempted: ["a", "c"] },
      why:
        "buckets exist so a stuck edit to one resource cannot hold another hostage; " +
        "collapsing them lets one bad record freeze the whole queue",
    },
    {
      name: "a conflict parks its bucket",
      queue: [it({ id: "a" }), it({ id: "b" })],
      tombstones: none,
      script: { a: "conflict" },
      expect: { replayed: 0, conflicts: 1, failed: 0, suppressed: 0, attempted: ["a"] },
      why: "a conflict awaits a human decision; writing past it discards the decision",
    },
    {
      name: "a pre-existing unresolved conflict parks the bucket before any attempt",
      queue: [it({ id: "a", status: "conflict" }), it({ id: "b" })],
      tombstones: none,
      script: {},
      expect: { replayed: 0, conflicts: 0, failed: 0, suppressed: 0, attempted: [] },
      why:
        "the conflict survived the last drain and still needs resolving; " +
        "re-attempting it silently re-races the write the user has not judged yet",
    },
    {
      name: "an exhausted head does not strand the items behind it",
      queue: [it({ id: "a", status: "failed", attempts: 99 }), it({ id: "b" })],
      tombstones: none,
      script: {},
      expect: { replayed: 1, conflicts: 0, failed: 0, suppressed: 0, attempted: ["b"] },
      why:
        "an abandoned item is never coming back; parking the bucket on it means " +
        "every later edit to that resource is stuck forever with no way out",
    },
    {
      name: "an already-parked dead-letter head does not strand the items behind it",
      queue: [it({ id: "a", status: "dead-letter", attempts: 99 }), it({ id: "b" })],
      tombstones: none,
      script: {},
      expect: { replayed: 1, conflicts: 0, failed: 0, suppressed: 0, attempted: ["b"] },
      why:
        "the same requirement as the case above, reached by a DIFFERENT branch. " +
        "Desktop tests `status === 'dead-letter'` and `attempts >= MAX` " +
        "separately, so an item that is already parked exercises neither the " +
        "budget check nor the shared predicate — a fixture with only the " +
        "exhausted-attempts case leaves that branch unguarded, which a mutation " +
        "confirmed: breaking it changed no test",
    },
    {
      name: "a suppressed item is dropped without parking the bucket",
      queue: [it({ id: ONE }), it({ id: TWO })],
      tombstones: oneDeleted,
      script: {},
      expect: { replayed: 1, conflicts: 0, failed: 0, suppressed: 1, attempted: [TWO] },
      why:
        "there is nothing to resolve and no later drain that makes it replayable, " +
        "so parking on it strands the bucket permanently",
    },
    {
      name: "an unrelated record is not suppressed by someone else's tombstone",
      queue: [it({ id: TWO })],
      tombstones: oneDeleted,
      script: { [TWO]: "failed" },
      expect: { replayed: 0, conflicts: 0, failed: 1, suppressed: 0, attempted: [TWO] },
      why:
        "an engine that passes the wrong id or omits `resource` suppresses " +
        "everything; this is the case that catches it",
    },
  ];
}

/**
 * Builds the injected replay for a scenario and records what it was asked to send.
 *
 * Shared so every engine's test observes attempts the same way — a per-engine
 * spy is one more thing that can be written to agree with its own engine.
 */
export function scriptedReplay(scenario: FailureScenario): {
  replay: (item: { id: string }) => Promise<"replayed" | "conflict" | "failed">;
  attempted: string[];
} {
  const attempted: string[] = [];
  return {
    attempted,
    replay: async (queued) => {
      attempted.push(queued.id);
      const outcome = scenario.script[queued.id] ?? "replayed";
      if (outcome === "throw") throw new Error("injected transport failure");
      return outcome;
    },
  };
}
