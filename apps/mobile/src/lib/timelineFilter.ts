/**
 * lib/timelineFilter.ts — facets for the subscriber activity timeline.
 *
 * THE PROBLEM. `TimelineEvent` already classifies eleven event types, and
 * nothing exposed that classification to the user. On a phone roughly six rows
 * are visible at once, so "when did this person last bounce?" on an account
 * with 500 sends means scrolling pages of opens. (Not a parity gap — desktop's
 * Timeline has no type filter either.)
 *
 * THE HONESTY CONSTRAINT, and why it shapes the API. `GET
 * /api/v1/subscribers/{id}/timeline` has NO type parameter, so this filter can
 * only see the pages already loaded. A filter that silently narrows a
 * cursor-paginated list is a trap: "no bounces" would mean "no bounces in the
 * 200 events fetched so far", and the user would read it as a fact about the
 * person. So the module returns a `TimelineFilterResult` carrying BOTH the
 * rows and the disclosure the screen must render, and `filterNote` states the
 * scope in every case where it is not the whole record.
 *
 * UNKNOWN TYPES. The server may add event types at any time. An unknown type
 * belongs to no facet, so it stays visible under "All" and never appears under
 * a facet whose name would misdescribe it — but `unclassified` counts it, so
 * the note can say the filter did not recognise everything rather than quietly
 * dropping rows an operator is looking for.
 *
 * DELIBERATELY IMPORT-FREE — no react-native — so the "never claim a fact
 * about the record" rule is unit-testable in the node vitest environment.
 */

export type TimelineFacet =
  | "all"
  | "sends"
  | "engagement"
  | "problems"
  | "lifecycle";

/** Minimal shape: only the discriminator this module reads. */
export interface TimelineFacetable {
  type: string;
}

/**
 * Facet membership, keyed by the SAME literals `humaniseType` switches on in
 * TimelineEvent.tsx. Both spellings of each type (past tense and bare) are
 * listed because the gateway emits both.
 */
const FACET_TYPES: Readonly<Record<Exclude<TimelineFacet, "all">, readonly string[]>> = {
  sends: ["campaign_sent", "sent"],
  engagement: [
    "campaign_opened",
    "opened",
    "campaign_clicked",
    "clicked",
    "reply",
    "replied",
  ],
  problems: [
    "bounce",
    "bounced",
    "complaint",
    "unsubscribe",
    "unsubscribed",
  ],
  lifecycle: [
    "subscribe",
    "subscribed",
    "tagged",
    "tag_added",
    "tag_removed",
  ],
};

export const TIMELINE_FACETS: readonly {
  value: TimelineFacet;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "sends", label: "Sends" },
  { value: "engagement", label: "Engagement" },
  { value: "problems", label: "Problems" },
  { value: "lifecycle", label: "Lifecycle" },
];

const TYPE_TO_FACET: ReadonlyMap<string, TimelineFacet> = (() => {
  const map = new Map<string, TimelineFacet>();
  for (const facet of Object.keys(FACET_TYPES) as (keyof typeof FACET_TYPES)[]) {
    for (const type of FACET_TYPES[facet]) map.set(type, facet);
  }
  return map;
})();

/** The facet an event type belongs to, or null when unrecognised. */
export function facetForType(type: unknown): TimelineFacet | null {
  if (typeof type !== "string") return null;
  return TYPE_TO_FACET.get(type.trim().toLowerCase()) ?? null;
}

/** A facet value from persisted preferences, defaulting safely. */
export function asTimelineFacet(value: unknown): TimelineFacet {
  return TIMELINE_FACETS.some((f) => f.value === value)
    ? (value as TimelineFacet)
    : "all";
}

export interface TimelineFilterResult<T extends TimelineFacetable> {
  rows: T[];
  /** Events the loaded pages contained, before filtering. */
  loaded: number;
  /** Loaded events whose type this module does not recognise. */
  unclassified: number;
}

export function filterTimeline<T extends TimelineFacetable>(
  events: readonly T[],
  facet: TimelineFacet,
): TimelineFilterResult<T> {
  let unclassified = 0;
  const rows: T[] = [];
  for (const event of events) {
    const eventFacet = facetForType(event.type);
    if (eventFacet == null) unclassified++;
    if (facet === "all" || eventFacet === facet) rows.push(event);
  }
  return { rows, loaded: events.length, unclassified };
}

/** Per-facet match counts for the control's badges. */
export function facetCounts<T extends TimelineFacetable>(
  events: readonly T[],
): Record<TimelineFacet, number> {
  const counts: Record<TimelineFacet, number> = {
    all: events.length,
    sends: 0,
    engagement: 0,
    problems: 0,
    lifecycle: 0,
  };
  for (const event of events) {
    const facet = facetForType(event.type);
    if (facet) counts[facet] += 1;
  }
  return counts;
}

/**
 * The disclosure line, or null when there is genuinely nothing to qualify.
 *
 * The rule: say "loaded", never imply "ever". `hasMore` is the query's own
 * `hasNextPage`, so when older pages exist the note says so explicitly — that
 * is what stops an empty Problems facet reading as "this person has never
 * bounced".
 */
export function timelineFilterNote(args: {
  facet: TimelineFacet;
  shown: number;
  loaded: number;
  unclassified: number;
  hasMore: boolean;
}): string | null {
  const { facet, shown, loaded, unclassified, hasMore } = args;
  if (loaded === 0) return null;
  const parts: string[] = [];
  if (facet !== "all") {
    parts.push(
      `${shown} of ${loaded} loaded ${loaded === 1 ? "event" : "events"}.`,
    );
  }
  if (hasMore) {
    parts.push(
      facet === "all"
        ? "Older activity has not been loaded yet."
        : "This filters only what is loaded — load older activity to look further back.",
    );
  }
  if (facet !== "all" && unclassified > 0) {
    parts.push(
      `${unclassified} ${unclassified === 1 ? "event is" : "events are"} of a type this filter doesn't recognise; see All.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * The empty-state sentence for a facet that matched nothing. Deliberately a
 * question of SCOPE, not of fact.
 */
export function emptyFacetMessage(
  facet: TimelineFacet,
  hasMore: boolean,
): string {
  const noun =
    TIMELINE_FACETS.find((f) => f.value === facet)?.label.toLowerCase() ??
    "matching";
  return hasMore
    ? `No ${noun} activity in the events loaded so far. Load older activity to look further back.`
    : `No ${noun} activity on this subscriber's record.`;
}
