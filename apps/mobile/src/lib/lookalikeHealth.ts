/**
 * lib/lookalikeHealth.ts — how alarmed to be about one modeled audience, and
 * in what order the alarming ones reach a thumb.
 *
 * Split from lib/lookalikeAudiences so neither file grows past the source
 * budget, and because the seam is real: that file parses what the server SENT,
 * this one decides what it MEANS. Both are import-free so they run in the node
 * vitest environment.
 *
 * THE ONE THING THIS SURFACE MUST NEVER DO is render a half-built audience as
 * a finished one. `CreateLookalike` inserts a literal `'ready'`
 * (subscribers/lookalike.go:169) because it ranks inline, but the column's
 * CHECK admits 'pending' | 'running' | 'failed' as well and migration 0949 says
 * in as many words that the status exists "so a future async generator can
 * report progress". So `building` and `unknown` are first-class states here,
 * they outrank every quality judgement, and they suppress the member count
 * rather than printing a number that is not final.
 *
 * THE FOUR THINGS WORTH KNOWING FROM A PHONE, each derivable from the LIST row
 * alone — which is what makes this a one-request surface:
 *
 *  1. DID IT BUILD.       status, and `error` when it did not.
 *  2. IS IT EMPTY.        `member_count == 0` on a ready row means the model
 *                         found nobody above the floor. Sending to it reaches
 *                         no one, and nothing else on the row says so.
 *  3. IS IT MOSTLY NOISE. `payload.bands` buckets members at 0.8 and 0.5
 *                         (lookalike.go:419-432). An audience whose LOW band
 *                         outnumbers the other two combined is majority
 *                         sub-0.5 similarity — filler that was only kept
 *                         because the audience was built with no confidence
 *                         floor.
 *  4. DID IT FILL THE ASK. `Rank` truncates to `size` (similarity.go:177-179), so
 *                         `member_count < size_requested` is a genuine
 *                         shortfall: the eligible pool ran out.
 *
 * WHY "STALE" IS A UI CONVENTION AND SAYS SO. A lookalike is materialised ONCE
 * (lookalike.go:182-196); there is no refresh route and no scheduler in the
 * package, so the audience is a frozen snapshot that ages while its seed
 * segment moves. The server has no opinion about when that becomes a problem,
 * so neither does this module beyond a stated threshold — and every string that
 * uses it names the number, so nobody mistakes it for a server rule.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Age past which the screen calls a model stale. A UI convention, not a server
 * rule — see the header. Every string derived from it prints the number.
 */
export const LOOKALIKE_STALE_DAYS = 30;

/** `LookalikeSeedSampleCap` / `LookalikeCandidatePoolCap` (lookalike.go:52-59). */
const SEED_SAMPLE_CAP = 20_000;
const CANDIDATE_POOL_CAP = 50_000;

/**
 * The slice of a parsed audience this module reasons over. Declared
 * structurally rather than importing `LookalikeAudience` so a caller can hand
 * in a hand-built object in a test without constructing every field.
 */
export interface LookalikeHealthInputs {
  status: "pending" | "running" | "ready" | "failed" | null;
  memberCount: number | null;
  sizeRequested: number | null;
  seedCount: number | null;
  candidateCount: number | null;
  bands: { high: number | null; medium: number | null; low: number | null };
  createdAt: string | null;
}

export type LookalikeHealthState =
  | "failed"
  | "empty"
  | "unknown"
  | "building"
  | "weak"
  | "short"
  | "ready";

/**
 * Precedence, highest first. `failed` and `empty` lead because both mean the
 * audience cannot be used at all; `unknown` outranks `building` because an
 * unrecognised status is a claim this build cannot interpret, whereas
 * 'pending'/'running' is a state we understand. Quality judgements come last
 * because they only make sense once the model has actually finished.
 */
export function lookalikeHealthState(
  audience: LookalikeHealthInputs,
): LookalikeHealthState {
  if (audience.status === "failed") return "failed";
  if (audience.status === null) return "unknown";
  if (audience.status !== "ready") return "building";
  // From here the row IS finished, so its numbers are final.
  if (audience.memberCount === 0) return "empty";
  if (isWeakMatch(audience) === true) return "weak";
  if (shortfallOf(audience) !== null) return "short";
  return "ready";
}

export interface LookalikeHealthPresentation {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger" | "info";
  spoken: string;
}

const PRESENTATION: Readonly<
  Record<LookalikeHealthState, LookalikeHealthPresentation>
> = {
  failed: {
    label: "Failed",
    tone: "danger",
    spoken:
      "Failed: this model did not finish building, so there is no audience behind it.",
  },
  empty: {
    label: "Empty",
    tone: "danger",
    spoken:
      "Empty: the model finished but matched nobody, so sending to this audience reaches no one.",
  },
  unknown: {
    label: "Unrecognised state",
    tone: "warning",
    spoken:
      "The server reported a state this app does not recognise, so its member count is not being treated as final.",
  },
  building: {
    label: "Building",
    tone: "info",
    spoken:
      "Still building: its member count is not final yet, so nothing here is the finished audience.",
  },
  weak: {
    label: "Weak match",
    tone: "warning",
    spoken:
      "Weak match: more than half of these members scored below 0.5 similarity to the seed, so most of this audience is filler.",
  },
  short: {
    label: "Short",
    tone: "warning",
    spoken:
      "Short: the model matched fewer people than were asked for, so the eligible pool ran out.",
  },
  ready: {
    label: "Ready",
    tone: "success",
    spoken:
      "Ready: it built cleanly and filled the size that was asked for.",
  },
};

export function lookalikeHealthPresentation(
  state: LookalikeHealthState,
): LookalikeHealthPresentation {
  return PRESENTATION[state];
}

/** Attention order: everything that is not `ready` leads, worst first. */
const ATTENTION_RANK: Readonly<Record<LookalikeHealthState, number>> = {
  failed: 0,
  empty: 1,
  unknown: 2,
  building: 3,
  weak: 4,
  short: 5,
  ready: 6,
};

/**
 * How far short of the requested size the model landed, or null when it filled
 * the ask (or when either figure is absent — a missing measurement is not a
 * shortfall of zero).
 *
 * `share` is the MISSING fraction, so 0.19 reads "19% short".
 */
export function shortfallOf(
  audience: Pick<LookalikeHealthInputs, "memberCount" | "sizeRequested">,
): { missing: number; share: number } | null {
  const { memberCount, sizeRequested } = audience;
  if (memberCount === null || sizeRequested === null) return null;
  if (sizeRequested <= 0) return null;
  if (memberCount >= sizeRequested) return null;
  const missing = sizeRequested - memberCount;
  return { missing, share: missing / sizeRequested };
}

/**
 * True when the model hit the ceiling it was given — `member_count` exactly
 * equals `size_requested`, which after `Rank`'s truncation means there may well
 * have been MORE eligible people the audience simply had no room for. Worth
 * saying, because it is the opposite reading from a shortfall and the two
 * numbers look identical at a glance.
 */
export function filledToCeiling(
  audience: Pick<LookalikeHealthInputs, "memberCount" | "sizeRequested">,
): boolean {
  const { memberCount, sizeRequested } = audience;
  if (memberCount === null || sizeRequested === null) return false;
  if (sizeRequested <= 0 || memberCount <= 0) return false;
  return memberCount >= sizeRequested;
}

export interface LookalikeBandTotals {
  high: number;
  medium: number;
  low: number;
  total: number;
}

/**
 * The similarity histogram, or null when ANY band is missing. Null rather than
 * a partial sum on purpose: a breakdown with one band silently treated as zero
 * would understate exactly the band that is missing, and the whole point of the
 * panel is the proportion.
 */
export function bandTotals(
  audience: Pick<LookalikeHealthInputs, "bands">,
): LookalikeBandTotals | null {
  const { high, medium, low } = audience.bands;
  if (high === null || medium === null || low === null) return null;
  return { high, medium, low, total: high + medium + low };
}

/**
 * True when the LOW band outnumbers the other two combined, false when it does
 * not, and null when the histogram is unavailable. Three-valued because "we do
 * not know how similar this audience is" is a different answer from "it is
 * fine", and only one of them should be silent on screen.
 */
export function isWeakMatch(
  audience: Pick<LookalikeHealthInputs, "bands">,
): boolean | null {
  const totals = bandTotals(audience);
  if (totals === null) return null;
  if (totals.total === 0) return null;
  return totals.low > totals.high + totals.medium;
}

/**
 * The pools the ranker was allowed to look at, and whether either was cut off.
 *
 * Only an EXACT match on the cap is reported, and that is deliberate. The
 * candidate query is `LIMIT 50000` BEFORE seed members are subtracted
 * (lookalike.go:139-148), so a pool of 49,900 might have been truncated
 * or might be the whole workspace — there is no way to tell from the wire. An
 * exact 50,000 can only happen when the limit bit, so that is the only case
 * this reports, and it reports it as certain.
 */
export function poolTruncation(
  audience: Pick<LookalikeHealthInputs, "seedCount" | "candidateCount">,
): { seedCapped: boolean; candidatesCapped: boolean } {
  return {
    seedCapped: audience.seedCount === SEED_SAMPLE_CAP,
    candidatesCapped: audience.candidateCount === CANDIDATE_POOL_CAP,
  };
}

/** Whole days since the model was materialised, or null for an absent date. */
export function lookalikeAgeDays(
  audience: Pick<LookalikeHealthInputs, "createdAt">,
  now: number,
): number | null {
  if (!audience.createdAt) return null;
  const built = Date.parse(audience.createdAt);
  if (!Number.isFinite(built)) return null;
  const days = Math.floor((now - built) / DAY_MS);
  return days < 0 ? 0 : days;
}

/**
 * Stale means "older than LOOKALIKE_STALE_DAYS" and nothing more. A model whose
 * build date is unknown is NOT called stale — an absent measurement is not a
 * verdict.
 */
export function isStaleLookalike(
  audience: Pick<LookalikeHealthInputs, "createdAt">,
  now: number,
): boolean {
  const days = lookalikeAgeDays(audience, now);
  return days !== null && days > LOOKALIKE_STALE_DAYS;
}

/**
 * The filter chips. `all`, the rows that are not `ready`, and the rows old
 * enough that the seed has almost certainly moved underneath them. There is
 * deliberately no "show me the fine ones" chip.
 */
export const LOOKALIKE_FILTERS = ["all", "attention", "stale"] as const;
export type LookalikeFilter = (typeof LOOKALIKE_FILTERS)[number];

export function matchesLookalikeFilter(
  audience: LookalikeHealthInputs,
  filter: LookalikeFilter,
  now: number,
): boolean {
  if (filter === "all") return true;
  if (filter === "stale") return isStaleLookalike(audience, now);
  return lookalikeHealthState(audience) !== "ready";
}

export function lookalikeFilterCounts(
  audiences: readonly LookalikeHealthInputs[],
  now: number,
): Record<LookalikeFilter, number> {
  const counts: Record<LookalikeFilter, number> = {
    all: audiences.length,
    attention: 0,
    stale: 0,
  };
  for (const audience of audiences) {
    if (lookalikeHealthState(audience) !== "ready") counts.attention += 1;
    if (isStaleLookalike(audience, now)) counts.stale += 1;
  }
  return counts;
}

/**
 * Free-text match over the model's name, its seed segment's name when the
 * segments catalogue resolved it, and the id prefix an operator might paste
 * from a desktop URL. Case-insensitive; an empty query matches everything.
 */
export function matchesLookalikeQuery(
  audience: { id: string; name: string },
  query: string,
  seedName: string | null,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (audience.name.toLowerCase().includes(needle)) return true;
  if (seedName !== null && seedName.toLowerCase().includes(needle)) return true;
  return audience.id.toLowerCase().startsWith(needle);
}

/**
 * Attention first, then NEWEST first inside a band. Newest rather than oldest
 * is the right tiebreak here — unlike a sync, a lookalike is a one-off artefact
 * and the one somebody just built is the one they are asking about. A row with
 * no build date sinks to the end of its band rather than jumping the queue.
 */
export function orderLookalikes<T extends LookalikeHealthInputs>(
  audiences: readonly T[],
): T[] {
  return [...audiences].sort((a, b) => {
    const rank =
      ATTENTION_RANK[lookalikeHealthState(a)] -
      ATTENTION_RANK[lookalikeHealthState(b)];
    if (rank !== 0) return rank;
    const at = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
    const bt = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
    const aOk = Number.isFinite(at);
    const bOk = Number.isFinite(bt);
    if (aOk && bOk) return bt - at;
    if (aOk) return -1;
    if (bOk) return 1;
    return 0;
  });
}
