/**
 * hooks/useLandingPages.ts — the landing-page list, and one page's leads.
 *
 * TWO QUERIES, NOT THREE. The list already carries every column the detail
 * sheet shows (`Repo.Get` selects the same list as `Repo.List`), so opening a
 * page costs exactly one request: its leads. The leads query is keyed by page
 * id and disabled until a page is open, so a closed sheet fetches nothing.
 *
 * STALENESS. A landing page changes when someone edits it on a laptop, so the
 * list can be cached for minutes. LEADS are the opposite: the reason to open
 * this on a phone is "did the campaign we just launched capture anyone", so
 * `staleTime: 0` — every open re-reads.
 *
 * THE MUTATIONS (desktop-parity pass): status (publish/unpublish/restore),
 * create, and the soft archive. All ADMIN server-side (`ScopeAdmin` on
 * POST/PATCH/DELETE) and all ONLINE-ONLY: none is registered in
 * lib/offlineMutationContract, because each one changes what the public
 * internet is served and a queued replay an hour later answers a question
 * nobody is still asking. Screens refuse the tap offline instead.
 *
 * Block/seo/tracking authoring remains desk-side — see api/landingPages.ts.
 *
 * OFFLINE. Both queries go through `useOnlineQueryGate` with
 * `enabled: gate.enabled && Boolean(gate.tenantId)` — the house rule enforced
 * by hooks/online-query-gating.test.ts. The persisted query cache still serves
 * the last list read offline; the screen's five-state ladder says "offline"
 * rather than "no pages" when there is nothing cached.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  archiveLandingPage,
  createLandingPage,
  fetchLandingLeads,
  fetchLandingPages,
  updateLandingPageStatus,
} from "@/api/landingPages";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import type { MobileLandingPage, MobileLead } from "@/lib/landingPages";

const LIST_KEY = "landing-pages";
const LEADS_KEY = "landing-page-leads";

/** Pages are edited on a desktop; a few minutes of cache costs nothing. */
const LIST_STALE_MS = 3 * 60_000;

export function landingPagesQueryKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return [LIST_KEY, tenantId ?? null];
}

export function landingLeadsQueryKey(
  tenantId: string | null | undefined,
  pageId: string | null,
): readonly unknown[] {
  return [LEADS_KEY, tenantId ?? null, pageId];
}

export function useLandingPages() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: landingPagesQueryKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: LIST_STALE_MS,
    queryFn: (): Promise<MobileLandingPage[]> => fetchLandingPages(),
  });
}

/**
 * The open page's leads. `pageId === null` (sheet closed) leaves the query
 * disabled, so the list screen never fetches a lead it has nowhere to show.
 *
 * The queryFn re-checks the id rather than asserting it non-null. `enabled`
 * governs AUTOMATIC fetching; a pull-to-refresh calls `refetch()` directly, and
 * with a null id an unguarded call would ask the server for the leads of a page
 * literally named "null" — a request that succeeds, returns nothing, and would
 * be indistinguishable from a page with no leads.
 */
export function useLandingLeads(pageId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: landingLeadsQueryKey(gate.tenantId, pageId),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(pageId),
    staleTime: 0,
    queryFn: (): Promise<MobileLead[]> =>
      pageId ? fetchLandingLeads(pageId) : Promise.resolve([]),
  });
}

/** Mirrors FormsOfflineError: an honest refusal at the moment of the tap. */
export class LandingOfflineError extends Error {
  readonly code = "offline_write_refused";

  constructor(action: string) {
    super(`${action} needs a connection. Reconnect and try again.`);
    this.name = "LandingOfflineError";
  }
}

/**
 * The list carries every column the sheet renders (`Repo.Get` selects the
 * same list as `Repo.List`), so invalidating the LIST is what refreshes an
 * open detail sheet too — there is no separate detail query to chase.
 */
export function useUpdateLandingPageStatus() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      status: "draft" | "published";
    }): Promise<MobileLandingPage | null> => {
      if (!isProbablyOnline())
        throw new LandingOfflineError("Changing what the public is served");
      return updateLandingPageStatus(input.id, input.status);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: landingPagesQueryKey(tenantId) as unknown[],
      });
    },
  });
}

export function useCreateLandingPage() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: { name: string; slug: string }) => {
      if (!isProbablyOnline())
        throw new LandingOfflineError("Creating a page");
      return createLandingPage(input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: landingPagesQueryKey(tenantId) as unknown[],
      });
    },
  });
}

/** The soft archive. The row survives (status='archived'), so the list is
 *  invalidated rather than the page's queries being removed. */
export function useArchiveLandingPage() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!isProbablyOnline())
        throw new LandingOfflineError("Archiving a page");
      return archiveLandingPage(id);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: landingPagesQueryKey(tenantId) as unknown[],
      });
    },
  });
}
