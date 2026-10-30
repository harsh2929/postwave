/**
 * lib/sequenceWireDiff.ts — "does this canvas edit change anything the server
 * can see?", answered on the WIRE tree rather than the canvas model.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY IT IS NOT AN OP-DELTA ENCODER (AUTOMATION#38)
 * ────────────────────────────────────────────────────────────────────────────
 * The Voice service exposes an operation-delta surface on
 * `PATCH /api/v1/voice/sequences/{id}` — `ops:[{op,step_id,after_id,…}]`,
 * decoded into `updateSequenceRequest.Ops`
 * (services/voice/internal/handlers/sequences.go:93) and folded over the
 * current tree by `applySequenceOps` (:1117). Mobile deliberately does NOT
 * send it, and the reasons are worth writing down where the save path lives:
 *
 *  1. IT DOES NOT REDUCE 412s. Every sequence PATCH — ops included — goes
 *     through the same compare-and-swap (`writeWithIfMatch`, sequences.go:993),
 *     and the struct comment says so outright (:90-92: "requests that include
 *     Ops MUST send an If-Match"). An op delta has exactly the same
 *     precondition footprint as a full array.
 *
 *  2. IT IS NOT SOUND UNDER THIS CLIENT'S REPLAY PROTOCOL. `executeSequenceSave`
 *     re-points a queued write at a NEWER revision than the one it was authored
 *     against — `expectedVersion = Math.max(vars.baseVersion, cachedVersion)`
 *     (lib/offlineMutations.ts). That is safe precisely BECAUSE the payload is a
 *     whole snapshot: replaying a later snapshot over an earlier one converges
 *     on what the user last saw. An op delta does not have that property. Ops
 *     address steps by POSITION (`indexByPosition`, sequences.go:1187) and the
 *     handler renumbers 1..N after EVERY op (:1176-1178), so a delta computed
 *     against v_n and admitted at v_{n+1} passes If-Match and silently writes a
 *     DIFFERENT tree. Two queued saves would corrupt the draft with no error at
 *     all. (Demonstrated against the real Go implementation in
 *     services/voice/internal/handlers/sequence_ops_convergence_test.go.)
 *
 *  3. THE DATA-LOSS MOTIVE IS ALREADY GONE. The original argument for ops was
 *     that a full replace destroys fields mobile does not model. It no longer
 *     does: `canvasToWire` round-trips body_mjml / template_id / delay_seconds /
 *     variants (components/sequence-builder/wire.ts:143-157).
 *
 * What is left of the finding is wire bytes — and the largest available saving
 * is not a smaller body, it is NOT SENDING THE REQUEST AT ALL. The canvas
 * queues a save from every structural action, including ones that resolve to
 * no change: moving the first step "up" returns the list untouched, and an
 * editor sheet dismissed without an edit re-commits the same step. Both used
 * to enqueue a PATCH that the server answers 400 "patch does not change the
 * sequence" (`sequenceAuthoringEqual`, sequences.go:986) — a wasted round trip
 * AND a user-visible error toast for an action that did nothing wrong.
 *
 * So this module supplies the comparison that suppresses those, and nothing
 * else. It is import-free so it is unit-testable in the node environment.
 *
 * EQUALITY IS DEFINED ON THE JSON THE SERVER WILL RECEIVE, not on the objects.
 * `undefined` is therefore identical to absent (JSON.stringify drops it, so the
 * server cannot tell them apart) and object key order is irrelevant, while
 * array order is significant — a reorder IS a change.
 */

/*
 * Inputs are typed `unknown`, not a JSON-value union. Callers pass
 * `SequenceStepWire[]` — a closed interface with no index signature — so a
 * structural JSON type would either force a cast at every call site or oblige
 * this file to re-declare the wire shape, where it would drift from the real
 * one. The comparison is defined over the JSON projection and does not need
 * the type to be correct.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keys whose value is `undefined` are invisible on the wire, so they are not
 * part of the identity of the payload.
 */
function definedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

/** Structural equality over the JSON projection of two wire values. */
export function wireValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Normalise the two ways "absent" can be spelled before anything else.
  if (a === undefined || b === undefined) return a === b;
  if (a === null || b === null) return a === b;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => wireValueEqual(item, b[index]));
  }

  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const aKeys = definedKeys(a);
    const bKeys = definedKeys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        wireValueEqual(a[key], b[key]),
    );
  }

  // Primitives that were not `===`. NaN is not a legal JSON number and the
  // canvas never produces one, but treating it as unequal is the safe answer
  // (it would serialize as `null` and so is not something to suppress on).
  return false;
}

/**
 * True when two serialized step lists would produce byte-identical JSON, i.e.
 * a PATCH carrying `next` would be refused with 400 "patch does not change the
 * sequence".
 *
 * `null` / `undefined` are read as "no list", which is NOT the same as an empty
 * list: the handler treats an absent `steps` field as "leave the tree alone"
 * and an empty array as "clear the canvas". Conflating them here would let a
 * clear be swallowed.
 */
export function sequenceWireStepsEqual(
  a: readonly unknown[] | null | undefined,
  b: readonly unknown[] | null | undefined,
): boolean {
  if (a == null || b == null) return a == null && b == null;
  return wireValueEqual(a, b);
}

/**
 * The question the save path actually asks: is there anything here worth
 * spending a round trip on?
 *
 * Kept as its own named export rather than `!sequenceWireStepsEqual(...)` so
 * the call site reads as intent, and so the rule has one place to change if
 * the sequence PATCH ever gains a field beyond the step tree.
 */
export function sequenceSaveIsWorthSending(
  lastSent: readonly unknown[] | null | undefined,
  next: readonly unknown[] | null | undefined,
): boolean {
  return !sequenceWireStepsEqual(lastSent, next);
}
