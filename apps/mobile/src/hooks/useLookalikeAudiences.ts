/**
 * hooks/useLookalikeAudiences.ts — the catalogue, and the opt-in member sample.
 *
 * ONE REQUEST TRIAGES EVERYTHING. `ListLookalikes` selects the same fourteen
 * columns `GetLookalike` does (subscribers/lookalike.go:206-211 vs :250-255),
 * and the `payload` jsonb on each row carries the seed count, the candidate
 * count and the similarity histogram. So every judgement this surface makes —
 * did it build, is it empty, is it mostly filler, did it fill the ask — comes
 * off the list. There is no per-row detail fetch on open, because a detail
 * fetch would return bytes already on screen and give them a second chance to
 * disagree.
 *
 * THE MEMBER SAMPLE IS LAZY *AND* OPT-IN, WHICH IS ONE MORE STEP THAN LAZY.
 * `GetLookalike` returns an empty members array unless `include_pii=true`
 * (lookalike.go:262); the type comment states the intent — "a status poll
 * cannot accidentally hydrate subscriber PII" (types.go:478-481). Opening the
 * detail sheet therefore fetches NOTHING. The query only enables once someone
 * taps to reveal the ranked members, so the identities of real subscribers are
 * never pulled onto a phone as a side effect of looking at a size.
 *
 * NOTHING POLLS, AND NOTHING IS INVALIDATED IN THE BACKGROUND. A lookalike is
 * materialised once at create and nothing re-scores it afterwards: there is no
 * scheduler, no refresh route and no runner anywhere in the package, and the
 * ONLY writer that touches the header after the insert is `ExportLookalike`
 * setting a destination id (subscribers/lookalike.go:353). A poll would spend a
 * request per interval to re-read a row that changes only when a human does
 * something on desktop, so the catalogue refreshes on focus and on pull, and
 * that is the honest cadence. The short stale window exists for exactly that
 * case — a model built on desktop a moment ago.
 *
 * NOTHING IS PERSISTED. `shouldPersistQuery` returns false for every query in
 * this app (lib/queryClient.ts:86-93), which matters more here than usual: the
 * member page carries subscriber email addresses, and they must not reach disk.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchLookalikeAudiences,
  fetchLookalikeMembers,
} from "@/api/lookalikeAudiences";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  LookalikeAudience,
  LookalikeMemberPage,
} from "@/lib/lookalikeAudiences";

const LOOKALIKES_KEY = "lookalike-audiences";
const MEMBERS_KEY = "lookalike-members";

/**
 * A saved model does not change once built, so this is only ever stale with
 * respect to somebody CREATING one elsewhere. A minute is generous for that and
 * costs nothing for the far more common case of nothing having happened.
 */
const LOOKALIKES_STALE_MS = 60_000;

export function lookalikeAudiencesQueryKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return [LOOKALIKES_KEY, tenantId ?? null];
}

export function lookalikeMembersQueryKey(
  tenantId: string | null | undefined,
  audienceId: string | null,
): readonly unknown[] {
  return [MEMBERS_KEY, tenantId ?? null, audienceId];
}

export function useLookalikeAudiences() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: lookalikeAudiencesQueryKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: LOOKALIKES_STALE_MS,
    queryFn: (): Promise<LookalikeAudience[]> => fetchLookalikeAudiences(),
  });
}

/**
 * The top-ranked members of one audience. `audienceId` is null until somebody
 * asks for them, and that null is the whole privacy control: with it the query
 * never runs, so no `include_pii=true` request is ever made by simply looking
 * at a model.
 *
 * `staleTime: Infinity` because the member rows are materialised once at create
 * and no lookalike route ever rewrites them, so a refetch would return the
 * identical page at the cost of putting the same email addresses back over the
 * wire. The one thing in the codebase that DOES touch them is a subscriber
 * MERGE, which reparents a duplicate's member rows onto the survivor
 * (`merge_satellites.go:110`); the client-side answer to that is the two-minute
 * `gcTime` default rather than a poll, because a merge is not something anyone
 * performs while staring at this sheet.
 */
export function useLookalikeMembers(audienceId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: lookalikeMembersQueryKey(gate.tenantId, audienceId),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(audienceId),
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: (): Promise<LookalikeMemberPage> =>
      fetchLookalikeMembers(audienceId!),
  });
}
