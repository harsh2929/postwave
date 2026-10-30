/**
 * api/listMembership.ts — transport for editing membership FROM THE LIST.
 *
 *   POST   /api/v1/lists/{id}/subscribers            role=editor
 *   DELETE /api/v1/lists/{id}/subscribers/{sub_id}   role=editor
 *   GET    /api/v1/subscribers?q=…                   role=viewer  (candidates)
 *   GET    /api/v1/lists/{id}/subscribers?query=…    role=viewer  (who is
 *                                                    already on the list)
 *
 * Both writes accept the Listmonk bigint list id AND the Moosewave uuid
 * (resolveListUUID, members.go:245), so the detail route's param goes through
 * as-is — unlike the PATCH/DELETE in listsManage.ts, which are bigint-only.
 *
 * Parsing lives in lib/listMembershipRows.ts (react-native-free). This file is
 * only the wire: every call UNWRAPS the `{data, error}` envelope `rawRequest`
 * resolves to (src/api/request.ts) BEFORE parsing, and a failure THROWS with
 * the envelope's fields attached, so a 403 can be presented as the permission
 * rule it is (lib/errorCopy reads `.status`/`.denial`).
 *
 * THE CANDIDATE SEARCH IS TWO READS, NOT ONE, AND BOTH MUST LAND. Showing
 * someone as addable when their membership could not be checked is the silent
 * lie this pairing exists to prevent, so a failure on EITHER leg fails the
 * search into its error state rather than rendering half an answer.
 */
import { rawRequest } from "@/api/request";
import {
  memberIdSet,
  parseAddMembersResult,
  parseCandidatePage,
  type AddMembersResult,
  type ListCandidatePage,
} from "@/lib/listMembershipRows";

/** One page of candidates is enough on a phone; narrow the query instead. */
const CANDIDATE_PER_PAGE = 25;
/** members.go membersMaxPerPage — the widest membership check one read buys. */
const MEMBER_CHECK_PER_PAGE = 200;

function fail(
  error: { message?: string; status?: number },
  fallback: string,
): never {
  throw Object.assign(new Error(error.message || fallback), error);
}

async function read<T>(path: string, label: string): Promise<T> {
  const res = await rawRequest<T>("GET", path);
  if (res.error) fail(res.error, label);
  return res.data as T;
}

const listBase = (listId: string): string =>
  `/api/v1/lists/${encodeURIComponent(listId)}/subscribers`;

export interface ListCandidateSearch extends ListCandidatePage {
  /** Subscriber ids the same query proved are already on this list. */
  memberIds: Set<string>;
}

/**
 * Search people who could be added, and check the same query against the
 * list's own membership.
 *
 * The query is REQUIRED: the roster and the tenant's subscriber table are both
 * PII, and opening a sheet must not page through people nobody asked for (the
 * same rule the members section itself follows — see app/(tabs)/lists/[id]).
 */
export async function fetchListCandidates(
  listId: string,
  query: string,
): Promise<ListCandidateSearch> {
  const q = query.trim();
  if (!q) return { items: [], total: 0, memberIds: new Set<string>() };
  const candidateQs = new URLSearchParams();
  candidateQs.set("q", q);
  candidateQs.set("page", "1");
  candidateQs.set("per_page", String(CANDIDATE_PER_PAGE));
  const memberQs = new URLSearchParams();
  memberQs.set("query", q);
  memberQs.set("page", "1");
  memberQs.set("per_page", String(MEMBER_CHECK_PER_PAGE));

  const [candidates, members] = await Promise.all([
    read<unknown>(
      `/api/v1/subscribers?${candidateQs.toString()}`,
      "Couldn't search subscribers.",
    ),
    read<unknown>(
      `${listBase(listId)}?${memberQs.toString()}`,
      "Couldn't check who is already on this list.",
    ),
  ]);
  const page = parseCandidatePage(candidates);
  return { ...page, memberIds: memberIdSet([members]) };
}

/**
 * Add the selected people. Returns the server's `{added, skipped}` — or null
 * when the 200 carried no counts, which the copy layer renders as "updated"
 * rather than as a number nobody sent.
 */
export async function addListMembers(
  listId: string,
  subscriberIds: readonly string[],
): Promise<AddMembersResult | null> {
  const res = await rawRequest<unknown>("POST", listBase(listId), {
    subscriber_ids: [...subscriberIds],
  });
  if (res.error) fail(res.error, "Couldn't add those subscribers.");
  return parseAddMembersResult(res.data);
}

/** Detach one person from this list. 204 on success (see lib header). */
export async function removeListMember(
  listId: string,
  subscriberId: string,
): Promise<void> {
  const res = await rawRequest<unknown>(
    "DELETE",
    `${listBase(listId)}/${encodeURIComponent(subscriberId)}`,
  );
  if (res.error) fail(res.error, "Couldn't remove them from this list.");
}
