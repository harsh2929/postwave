/**
 * lib/listCataloguePolicy.ts — the cache policy for the workspace list
 * catalogue, in an import-free module.
 *
 * It lives here rather than beside `useListOptions` for the same reason
 * `campaignPolicy` and `subscriberQueryKeys` do: that hook transitively
 * imports react-native (through the client and the snapshot vault), so a node
 * test that reads these numbers off the hook cannot even parse. A policy
 * nobody can assert against is a policy that drifts.
 *
 * ── WHY THIS QUERY IS NOT ON THE CLIENT-WIDE DEFAULTS ──────────────────────
 * `useListOptions` inherited staleTime 30s / gcTime 2m from lib/queryClient.
 * Those are the right defaults for a feed and the wrong ones for a PICKER: the
 * add-to-list modal, the subscriber bulk sheets and the list detail header
 * each mount a FRESH observer on this key every time they open, so at 30s the
 * second open of a sheet inside the same minute of work paid a blocking round
 * trip before a single row could render — and at gcTime 2m a reader who had
 * never opened the Lists tab lost the catalogue between opens entirely and got
 * an empty sheet plus a spinner for something the device had just downloaded.
 *
 * ── WHY FIVE MINUTES IS SAFE RATHER THAN OPTIMISTIC ───────────────────────
 * Staleness is not this entry's refresh channel. Three others carry every
 * change that actually happens, and all three address `listCatalogueKey`,
 * which is a TRUE PREFIX of the query key:
 *
 *   1. Every list mutation invalidates it — create (useCreateList), rename and
 *      delete (useListManage), membership (useListMembership,
 *      useSubscriberLists, useSubscriberBulkActions). A local change shows up
 *      immediately, at any staleTime.
 *   2. The realtime bus maps `list.*` onto the `lists` root
 *      (api/event-cache-invalidation.ts), so a teammate's change lands within
 *      the invalidation debounce while the app is foregrounded.
 *   3. `lists` is in RECONNECT_REFETCH_QUERY_ROOTS (lib/queryClient.ts), so
 *      returning from a tunnel re-reads it.
 *
 * What the staleTime governs is therefore only the residue none of those
 * cover: a change made on another device while this one's event stream was
 * down. Five minutes of that, on a catalogue `useListOptions` itself describes
 * as "small, slow-moving", is a better trade than a round trip in front of
 * every picker.
 *
 * ── WHY gcTime IS MUCH LONGER THAN staleTime ──────────────────────────────
 * They answer different questions. staleTime decides whether a cached answer
 * may be SHOWN without re-asking; gcTime decides whether there is a cached
 * answer at all. Evicting a still-correct catalogue only buys back one small
 * array of heap and costs a blocking fetch to re-learn what the device already
 * knew. The endpoint is not paged and the rows are capped, so the array is
 * small by construction.
 */

/** How long a fetched catalogue may be served to a newly-opened picker. */
export const LIST_CATALOGUE_STALE_MS = 5 * 60_000;

/** How long an unobserved catalogue survives, so a reopen is not a cold start. */
export const LIST_CATALOGUE_GC_MS = 30 * 60_000;
