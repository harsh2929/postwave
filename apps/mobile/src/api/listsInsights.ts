/**
 * api/listsInsights.ts — transport for the per-list insight reads
 * (engagement breakdown, per-row engagement, activity feed, and the
 * suppression/forms/automations cross-references).
 *
 * Parsing lives in lib/listInsightRows.ts (react-native-free). This file is
 * only the wire: every read UNWRAPS the `{data, error}` envelope `rawRequest`
 * resolves to (src/api/request.ts) BEFORE parsing, and a failed read THROWS —
 * the audience-destinations regression showed that handing the envelope to a
 * parser renders every failure as a convincing empty state.
 *
 * These routes accept both the Listmonk bigint id and the Moosewave UUID
 * (resolveListID in apps/api/internal/lists), so the detail route's param can
 * be forwarded as-is — unlike the PATCH/DELETE writes in listsManage.ts.
 */
import { rawRequest } from "@/api/request";
import {
  engagementCheckIds,
  parseListActivity,
  parseListAutomations,
  parseListEngagement,
  parseListForms,
  parseListSuppressedTotal,
  parsePerRowEngagement,
  type ListActivityEvent,
  type ListCrossRefItem,
  type ListEngagementBreakdown,
  type MemberEngagementRow,
} from "@/lib/listInsightRows";

async function read<T>(
  path: string,
  parse: (raw: unknown) => T,
  label: string,
): Promise<T> {
  const res = await rawRequest<unknown>("GET", path);
  if (res.error) {
    throw Object.assign(new Error(res.error.message || label), res.error);
  }
  return parse(res.data);
}

const base = (listId: string): string =>
  `/api/v1/lists/${encodeURIComponent(listId)}`;

export async function fetchListEngagement(
  listId: string,
  windowDays = 30,
): Promise<ListEngagementBreakdown> {
  return read(
    `${base(listId)}/engagement-breakdown?window=${windowDays}d`,
    parseListEngagement,
    "Couldn't load the engagement breakdown.",
  );
}

/**
 * Per-row engagement for the ids the caller has materialised. Dedupes and
 * caps at the server's 500-id limit (lib/listInsightRows.engagementCheckIds)
 * so the request cannot 400. Returns the parsed rows plus whether the cap
 * trimmed the ask — the card must SAY when its answer covers a subset.
 */
export async function fetchPerRowEngagement(
  listId: string,
  subscriberIds: readonly (string | null | undefined)[],
): Promise<{ rows: MemberEngagementRow[]; capped: boolean }> {
  const { ids, capped } = engagementCheckIds(subscriberIds);
  if (ids.length === 0) return { rows: [], capped: false };
  const qs = new URLSearchParams();
  qs.set("subscriber_ids", ids.join(","));
  const rows = await read(
    `${base(listId)}/per-row-engagement?${qs.toString()}`,
    parsePerRowEngagement,
    "Couldn't load member engagement.",
  );
  return { rows, capped };
}

export async function fetchListActivity(
  listId: string,
  limit = 100,
): Promise<ListActivityEvent[]> {
  return read(
    `${base(listId)}/activity?limit=${limit}`,
    parseListActivity,
    "Couldn't load the activity feed.",
  );
}

export async function fetchListSuppressedTotal(
  listId: string,
): Promise<number> {
  return read(
    `${base(listId)}/suppressions?page=1&per_page=1`,
    parseListSuppressedTotal,
    "Couldn't load the suppression count.",
  );
}

export async function fetchListForms(
  listId: string,
): Promise<ListCrossRefItem[]> {
  return read(
    `${base(listId)}/forms`,
    parseListForms,
    "Couldn't load the forms for this list.",
  );
}

export async function fetchListAutomations(
  listId: string,
): Promise<ListCrossRefItem[]> {
  return read(
    `${base(listId)}/automations`,
    parseListAutomations,
    "Couldn't load the automations for this list.",
  );
}
