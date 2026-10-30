/**
 * lib/sequenceSeedPolicy.ts — the two decisions the sequence canvas makes
 * about a fetched detail, as pure functions over plain data.
 *
 * Separate from `hooks/useSequenceCanvasSeed` because that hook reaches the
 * offline-mutation scope, which transitively imports `react-native`. Anything
 * importing it is untestable in the node test environment. These two rules are
 * exactly the parts worth testing — both are "when does this value count as
 * real", and both destroy data when answered wrongly — so they live here with
 * NO runtime imports at all.
 */

/**
 * The subset of the fetched sequence detail the canvas seeds from.
 *
 * Generic over the wire step so the caller keeps its own element type through
 * `seedableSteps` — the decoder's input type is not exported, and widening to
 * `unknown[]` here would force a cast at the one place that actually knows
 * what the elements are.
 */
export interface SeedableSequenceDetail<TStep = unknown> {
  id?: string;
  name?: string | null;
  version?: number | undefined;
  steps?: readonly TStep[] | null | undefined;
  emails?: unknown;
}

/**
 * Reads a trustworthy `version` off a fetched detail.
 *
 * Anything that is not a positive safe integer is treated as ABSENT rather
 * than coerced. The version is the If-Match token guarding every write, so a
 * `0`, a float or a NaN is not a weaker token — it is a token that matches
 * nothing, and a write carrying it is either rejected or silently ignored.
 * Returning null instead makes the save path fail closed and say so.
 */
export function fetchedSequenceVersion(
  detail: SeedableSequenceDetail,
): number | null {
  const v = detail.version;
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/**
 * Picks the wire steps to seed from, tolerating the older `emails` shape that
 * predates branchable steps.
 *
 * An EMPTY `steps` also falls through to `emails`, and that is DELIBERATE:
 * `__tests__/sequence-detail.native.test.tsx` renders a sequence with
 * `steps: []` and two legacy `emails` and requires the header to read
 * "Paused · 2 steps". The Voice gateway returns `steps: []` for sequences that
 * predate the step model, so treating empty-as-authoritative would blank a
 * journey the user can plainly see on desktop.
 *
 * The cost is bounded: a step-model sequence carries no `emails`, so deleting
 * its last step yields `[]` either way. Only a MIGRATED sequence emptied down
 * to zero steps would repaint its pre-migration list — a strictly better
 * failure than showing an empty canvas for every unmigrated sequence.
 */
export function seedableSteps<TStep>(
  detail: SeedableSequenceDetail<TStep>,
): readonly TStep[] {
  if (detail.steps && detail.steps.length > 0) return detail.steps;
  if (Array.isArray(detail.emails)) return detail.emails as readonly TStep[];
  return [];
}
