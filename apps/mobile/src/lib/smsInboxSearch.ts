/**
 * smsInboxSearch — pure validation, decoding, and merging for server-side SMS
 * conversation search.
 *
 * The route is `POST /api/v1/sms/conversations/search`
 * (apps/api/internal/sms/inbox_extras.go:68, `SearchConversations`) — POST so
 * the query text (often a phone number or a fragment of a customer message)
 * never enters a URL or an edge access log. The GET twin at the same path is
 * permanently retired with 410 `search_query_in_url_retired` (:67, :1136), so
 * this module never builds a query string.
 *
 * The response rows are the SAME `ConversationSummary` shape the inbox list
 * serves, under a smaller envelope (`{tenantId, conversations, nextCursor?,
 * snapshotAt}` — no totals, no query identity echo: the server deliberately
 * does not echo the query back). Ordering is `last_at DESC, phone ASC`, i.e.
 * exactly the list's "recent" sort, so the same comparator polices pages.
 */
import {
  SmsContractError,
  type SmsConversationSummary,
} from "./smsConversation";
import {
  compareSmsConversationOrder,
  decodeSmsConversationSummary,
} from "./smsConversationWire";
import {
  wireExactKeys,
  wireNextCursor,
  wireObject,
  wireTenantEnvelope,
  wireTimestamp,
} from "./smsWirePrimitives";

export const SMS_SEARCH_MIN_CODE_POINTS = 3;
export const SMS_SEARCH_MAX_CODE_POINTS = 128;
/** Mirrors the server page bound: request limit is clamped to 1..200. */
const MAX_SEARCH_ROWS = 200;

/** Control (Cc) plus invisible format/bidi (Cf) — the same classes the server's
 *  `validInboxText` rejects (inbox.go:848-861). */
const FORBIDDEN = /[\p{Cc}\p{Cf}]/u;

/**
 * The one sentence explaining why a query cannot be submitted, or null when it
 * can. Mirrors `SearchConversations`' own gate (3..128 safe code points after
 * trimming) so the client never sends a request the server is certain to 400.
 */
export function smsSearchQueryError(query: string): string | null {
  const trimmed = query.trim();
  const points = Array.from(trimmed).length;
  if (points < SMS_SEARCH_MIN_CODE_POINTS) {
    return "Type at least 3 characters to search message text, phone, or email.";
  }
  if (points > SMS_SEARCH_MAX_CODE_POINTS) {
    return "Search text is limited to 128 characters.";
  }
  if (FORBIDDEN.test(trimmed)) {
    return "Search text cannot contain control or invisible characters.";
  }
  return null;
}

export interface SmsSearchPage {
  tenantId: string;
  conversations: SmsConversationSummary[];
  snapshotAt: string;
  nextCursor?: string | undefined;
}

export function decodeSmsSearchPage(
  raw: unknown,
  expected: { tenantId: string },
): SmsSearchPage {
  const src = wireObject(raw, "search response");
  wireExactKeys(
    src,
    ["tenantId", "conversations", "nextCursor", "snapshotAt"],
    "search response",
  );
  const tenantId = wireTenantEnvelope(src, expected.tenantId, "search response");
  const snapshotAt = wireTimestamp(src.snapshotAt, "search response.snapshotAt");
  const snapshotTime = Date.parse(snapshotAt);
  if (
    !Array.isArray(src.conversations) ||
    src.conversations.length > MAX_SEARCH_ROWS
  ) {
    throw new SmsContractError(
      "search conversations must be an array of at most 200 rows",
    );
  }
  const seen = new Set<string>();
  let previous: SmsConversationSummary | undefined;
  const conversations = src.conversations.map((entry, index) => {
    const path = `search conversations[${index}]`;
    const row = decodeSmsConversationSummary(entry, path, snapshotTime);
    if (seen.has(row.phoneE164))
      throw new SmsContractError(`${path} duplicates ${row.phoneE164}`);
    seen.add(row.phoneE164);
    if (previous && compareSmsConversationOrder(previous, row, "recent") > 0) {
      throw new SmsContractError(`${path} is out of recency order`);
    }
    previous = row;
    return row;
  });
  const cursor = wireNextCursor(src, "search response");
  return {
    tenantId,
    conversations,
    snapshotAt,
    ...(cursor ? { nextCursor: cursor } : {}),
  };
}

/**
 * Flatten continuation pages, refusing overlap, disorder, or a page from a
 * different response cutoff — the same discipline `mergeSmsConversationPages`
 * applies to the list.
 */
export function mergeSmsSearchPages(pages: readonly SmsSearchPage[]): {
  conversations: SmsConversationSummary[];
  snapshotAt: string | null;
  hasMore: boolean;
} {
  if (pages.length === 0) {
    return { conversations: [], snapshotAt: null, hasMore: false };
  }
  const first = pages[0] as SmsSearchPage;
  const conversations: SmsConversationSummary[] = [];
  const seen = new Set<string>();
  for (const [pageIndex, page] of pages.entries()) {
    if (
      page.snapshotAt !== first.snapshotAt ||
      page.tenantId !== first.tenantId
    ) {
      throw new SmsContractError(
        `search page ${pageIndex} is from another response cutoff`,
      );
    }
    for (const row of page.conversations) {
      if (seen.has(row.phoneE164))
        throw new SmsContractError("search pages overlap");
      const previous = conversations.at(-1);
      if (
        previous &&
        compareSmsConversationOrder(previous, row, "recent") > 0
      ) {
        throw new SmsContractError("search pages are out of order");
      }
      seen.add(row.phoneE164);
      conversations.push(row);
    }
  }
  return {
    conversations,
    snapshotAt: first.snapshotAt,
    hasMore: Boolean(pages.at(-1)?.nextCursor),
  };
}
