/**
 * lib/collectionInventory.ts — what a reference-collection LIST is allowed to
 * claim, and the four ways it could lie.
 *
 * 1. AN UNREPORTED COUNT IS NOT AN EMPTY TABLE. The summary projection sends
 *    `row_count` and stubs `data` to `[]` (`repo.go:126`, `repo.go:367`), so a
 *    missing count and a genuinely empty collection are different facts that a
 *    naive renderer collapses into the same "0". `collectionSizeLabel` keeps
 *    them apart: `null` prints an em-dash and says "not reported"; `0` prints
 *    "Empty" and says "0 rows", which is a real measurement and worth seeing —
 *    an overnight import that produced an empty table is exactly the failure
 *    somebody opens this screen to find.
 *
 * 2. A PAGE IS NOT THE WORKSPACE. The list is a keyset page of at most
 *    `MaxListLimit = 200` (`types.go:137`) with an exact, filter-wide `total`
 *    computed separately (`repo.go:113-119`). `collectionCoverageNote` prints
 *    both numbers so 50 rows are never read as "we have 50 collections".
 *
 * 3. "COUPONS" IS NOT THE COUPON RUNTIME. The package doc is unusually blunt
 *    about this (`types.go:6-11`): the legacy `coupons` collection type "is not
 *    the deployable coupon-pool runtime implemented by the discounts package
 *    and its coupon_pools tables", and callers "must not treat a reference
 *    collection as an automation/personalization runtime dependency". On a
 *    phone, a row reading "Summer codes · coupons · 5,000 rows" is otherwise
 *    read as "the promotion is armed". `couponReferenceCaveat` says it is not.
 *
 * 4. A QUERY THE SERVER WILL REJECT IS NOT A SEARCH. `parseListOptions` 400s a
 *    `q` longer than `MaxListSearchLength = 200` code points or containing any
 *    control / bidi-formatting rune (`handlers.go:343-350`, `validation.go:337`).
 *    `sanitizeCollectionQuery` decides that on the device so the screen shows a
 *    reason instead of a red error state produced by its own keystrokes.
 *
 * Plus one mechanical rule that is easy to get wrong: the keyset cursor is
 * BOUND TO ITS FILTERS. `decodeCollectionCursor` compares the envelope's `q`
 * and `collection_type` (and a tenant binding) against the request and returns
 * `ErrInvalidCursor` on any mismatch (`cursor.go:69-73`), so changing a filter
 * without dropping the cursor is a guaranteed 400. `collectionFilterKey` is the
 * identity a caller resets pagination on.
 *
 * Deliberately free of react-native imports so it runs under node vitest.
 */
import { EMDASH, num, plural } from "@/lib/format";
import {
  COLLECTION_TYPE_KEYS,
  type CollectionSummary,
} from "@/lib/collections";

/** `MaxListSearchLength` (`types.go:134`), counted in code points as Go does. */
export const MAX_COLLECTION_QUERY_LENGTH = 200;

/**
 * Page size. `DefaultListLimit` is 50 and `MaxListLimit` is 200
 * (`types.go:135-136`). 50 is kept deliberately: the row carries a name, a
 * type, a source, a count and a timestamp, and 200 of those is a scroll nobody
 * finishes on a phone — the filter and the search are the tools for a large
 * workspace, not a longer page.
 */
export const COLLECTION_PAGE_LIMIT = 50;

/** "All" plus the three server-side kinds, in the order the filter shows them. */
export const COLLECTION_TYPE_FILTERS = ["all", ...COLLECTION_TYPE_KEYS] as const;
export type CollectionTypeFilter = (typeof COLLECTION_TYPE_FILTERS)[number];

const TYPE_LABELS: Readonly<Record<string, string>> = {
  coupons: "Coupons",
  content: "Content",
  schedule: "Schedule",
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  uploaded: "Uploaded",
  api: "API",
  manual: "Manual",
};

/**
 * What each source means, in one clause, because the words alone do not carry
 * it: "api" means an integration wrote these rows, which is the difference
 * between "nobody has touched this in a month" being fine and being an outage.
 */
const SOURCE_EXPLANATIONS: Readonly<Record<string, string>> = {
  uploaded: "imported from a file",
  api: "written through the API",
  manual: "entered by hand",
};

/**
 * Display name for a collection type.
 *
 * An unrecognised value is echoed verbatim rather than mapped to a default: the
 * server may add a fourth kind before this app ships again, and silently
 * relabelling it "Content" would be a fabrication.
 */
export function collectionTypeLabel(type: string): string {
  const key = type.trim();
  if (!key) return "Untyped";
  return TYPE_LABELS[key] ?? key;
}

/** Display name for a source. Unknown values are echoed, never defaulted. */
export function collectionSourceLabel(source: string): string {
  const key = source.trim();
  if (!key) return "Unknown source";
  return SOURCE_LABELS[key] ?? key;
}

/** Spoken clause for a source, e.g. "Uploaded — imported from a file". */
export function collectionSourceSentence(source: string): string {
  const key = source.trim();
  const label = collectionSourceLabel(source);
  const explanation = SOURCE_EXPLANATIONS[key];
  return explanation ? `${label} — ${explanation}` : label;
}

export interface CollectionSizeLabel {
  /** What the row prints. An em-dash when the count was not reported. */
  text: string;
  /** The full sentence assistive tech hears. Never a bare number. */
  spoken: string;
  /** True only for a REPORTED count of zero — never for an unknown one. */
  empty: boolean;
}

/**
 * Turn `row_count` into something a row may print.
 *
 * The three cases are deliberately distinct, and conflating any two of them is
 * the defect this function exists to prevent.
 */
export function collectionSizeLabel(rowCount: number | null): CollectionSizeLabel {
  if (rowCount === null) {
    return {
      text: EMDASH,
      spoken: "Row count not reported",
      empty: false,
    };
  }
  if (rowCount === 0) {
    return {
      text: "Empty",
      spoken: "0 rows — this collection holds nothing",
      empty: true,
    };
  }
  return {
    text: num(rowCount),
    spoken: plural(rowCount, "row"),
    empty: false,
  };
}

/**
 * "Showing 50 of 312 collections" — or `null` when the page IS the whole set.
 *
 * `hasMore` comes from the presence of `next_cursor`, which the server sets
 * only when it read `limit + 1` rows (`repo.go:141-147`). Both signals are used
 * because they answer different questions: `total` can exceed the page while
 * the cursor is absent (a filter narrowed after the count), and the sentence
 * should still say so.
 */
export function collectionCoverageNote(
  shown: number,
  total: number | null,
  hasMore: boolean,
): string | null {
  if (total === null) {
    return hasMore
      ? "There are more collections than the ones listed here."
      : null;
  }
  if (total <= shown && !hasMore) return null;
  return `Showing ${num(shown)} of ${plural(total, "collection")}.`;
}

/**
 * The disclosure that has to appear when any `coupons` row is on screen.
 *
 * Returns `null` when no coupon-type collection is present, so the sentence is
 * never boilerplate a reader learns to skip.
 */
export function couponReferenceCaveat(
  items: readonly CollectionSummary[],
): string | null {
  const hasCoupons = items.some(
    (item) => item.collectionType.trim() === "coupons",
  );
  if (!hasCoupons) return null;
  return "A coupons collection is reference data only — it is not the coupon pool that discounts issue codes from, so rows here being present does not mean a promotion is live.";
}

export type CollectionQueryRejection = "too-long" | "unsafe-characters";

export interface SanitizedCollectionQuery {
  /** Exactly what should go on the wire as `q`; empty means "send no filter". */
  value: string;
  /** False when the server would reject this text with a 400. */
  submittable: boolean;
  /** Why it is not submittable — `null` when it is. */
  reason: CollectionQueryRejection | null;
  /** A sentence for the reader. `null` when there is nothing to say. */
  message: string | null;
}

/**
 * Control and bidirectional-formatting runes, matching `isUnsafeTextRune`
 * (`validation.go:337-347`) exactly — including the U+061C Arabic letter mark
 * and the U+2066..U+2069 isolates, which a `\p{Cc}` check alone would miss.
 */
const UNSAFE_TEXT_RE =
  /[\p{Cc}\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/**
 * Decide whether a search box's contents can be sent.
 *
 * Trimming mirrors the server (`handlers.go:342`), so "  invoices " and
 * "invoices" produce the same query key and the same cached page rather than
 * two identical round trips.
 */
export function sanitizeCollectionQuery(raw: string): SanitizedCollectionQuery {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") {
    return { value: "", submittable: true, reason: null, message: null };
  }
  if (UNSAFE_TEXT_RE.test(trimmed)) {
    return {
      value: "",
      submittable: false,
      reason: "unsafe-characters",
      message:
        "Search can't include control or text-direction characters — the server rejects them. Remove them to search.",
    };
  }
  // Code points, not UTF-16 units: Go counts runes, so an emoji is 1 there and
  // 2 in `String.length`, and a `.length` check would refuse a legal query.
  if ([...trimmed].length > MAX_COLLECTION_QUERY_LENGTH) {
    return {
      value: "",
      submittable: false,
      reason: "too-long",
      message: `Search is limited to ${MAX_COLLECTION_QUERY_LENGTH} characters.`,
    };
  }
  return { value: trimmed, submittable: true, reason: null, message: null };
}

/**
 * The identity a keyset cursor belongs to.
 *
 * Any change here must reset pagination to page one, because the server
 * re-derives the same binding and 400s a cursor that disagrees
 * (`cursor.go:69-73`). Returned as a string so it can be a query-key segment
 * and a `useEffect` dependency without a deep compare.
 */
export function collectionFilterKey(
  type: CollectionTypeFilter,
  query: string,
): string {
  const sanitized = sanitizeCollectionQuery(query);
  return `${type}::${sanitized.submittable ? sanitized.value : ""}`;
}

/** The `collection_type` value to send, or `""` for no filter. */
export function collectionTypeParam(type: CollectionTypeFilter): string {
  return type === "all" ? "" : type;
}

/**
 * The empty-state sentence, which must distinguish "this workspace has no
 * reference collections" from "your filter matched none of them". Told apart
 * by whether a filter is active, never by the row count alone.
 */
export function collectionEmptyMessage(
  type: CollectionTypeFilter,
  query: string,
): { title: string; description: string } {
  const filtered = type !== "all" || sanitizeCollectionQuery(query).value !== "";
  if (filtered) {
    return {
      title: "No matches",
      description:
        "No reference collection in this workspace matches the current filter. Clear it to see them all.",
    };
  }
  return {
    title: "No reference collections",
    description:
      "This workspace has no reference collections yet. They are created on the web admin — importing one needs a file, so it is not something this app does.",
  };
}

/**
 * True when a failed read is the server refusing this SESSION rather than
 * failing.
 *
 * 403 is the only status that means it: `RequireScope` writes 403
 * `insufficient_role` for a session below the floor and 403
 * `insufficient_scope` for an API key without the scope
 * (`apikeys/middleware.go:196-224`). A 401 is a different sentence (the session
 * is gone, and the app's auth layer owns that), and a 404 from the detail route
 * means the collection is not there for this tenant (`handlers.go:93-96`) —
 * both would be mislabelled by a broader check.
 */
export function isCollectionRoleDenied(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { status?: unknown }).status === 403;
}

/**
 * The one sentence the detail gate says, in both directions — pre-emptive and
 * live — so a reader who changes role mid-session does not get two different
 * explanations of the same rule.
 */
export const COLLECTION_DETAIL_GATE = {
  title: "Row contents need an editor session",
  body: "Reading one collection's rows requires the write:subscribers scope, because a collection can hold confidential lookup values. The catalogue above is readable by any role; the rows are not.",
} as const;
