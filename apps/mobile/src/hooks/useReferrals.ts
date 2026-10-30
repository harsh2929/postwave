/**
 * hooks/useReferrals.ts — the referral reads the server actually mounts.
 *
 * Three of them are unconditional; the rest (payouts, variants, and the
 * per-subscriber link) mount only when `OperationalRuntimeAvailable` is true in
 * apps/api/internal/referrals/referrals.go. lib/referrals.ts mirrors that
 * constant as `REFERRAL_RUNTIME_AVAILABLE` and lib/referrals.boundary.test.ts
 * holds the two together, so the `enabled` clauses below are the client's half
 * of a checked contract rather than a guess: with the gate shut those queries
 * never fire, and the screen shows a banner instead of three 404s.
 *
 * Parsing lives in lib/referrals.ts (import-free, unit-tested); this file is
 * only query wiring.
 *
 * The programme read is the interesting one: a 404 from
 * /referral-programs/current is a RESTING STATE ("nobody has configured a
 * programme"), not a failure, so it must not retry and must not land the card
 * in an error branch. Every other failure still surfaces as an error.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { payoutAdvanceRequest } from "@/lib/referralAdmin";
import {
  REFERRAL_RUNTIME_AVAILABLE,
  SUBSCRIBER_REFERRAL_MINIMUM_ROLE,
  subscriberReferralQueryEnabled,
  isNoActiveProgramError,
  parseReferralFunnel,
  parseReferralLeaderboard,
  parseReferralPayouts,
  parseReferralProgram,
  parseReferralVariants,
  parseSubscriberReferral,
  parseTopReferrerCount,
  parseTopReferrers,
  type ReferralFunnel,
  type ReferralLeaderboard,
  type ReferralPayoutList,
  type ReferralProgram,
  type ReferralTopReferrer,
  type ReferralVariant,
  type SubscriberReferral,
} from "@/lib/referrals";
import { useAuthStore } from "@/store/auth";

/**
 * A minute of staleness on programme shape, funnel totals and a 90-day
 * leaderboard costs nothing — none of them move at interaction speed — and it
 * saves a burst of requests on every screen focus.
 */
const REFERRALS_STALE_MS = 60_000;
const REFERRALS_GC_MS = 10 * 60_000;

export interface ReferralStatsResult {
  funnel: ReferralFunnel;
  /** How many distinct referrers appear in the 90-day top list. */
  topReferrerCount: number | null;
  /** The same 90-day rows in full, for the drill-down to a share link. */
  topReferrers: ReferralTopReferrer[];
}

export function useReferralStats() {
  const gate = useOnlineQueryGate();
  return useQuery<ReferralStatsResult>({
    queryKey: ["referrals", "stats", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: REFERRALS_STALE_MS,
    gcTime: REFERRALS_GC_MS,
    queryFn: async (): Promise<ReferralStatsResult> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        "/api/v1/referrals/stats",
      );
      return {
        funnel: parseReferralFunnel(res),
        topReferrerCount: parseTopReferrerCount(res),
        topReferrers: parseTopReferrers(res),
      };
    },
  });
}

export function useReferralLeaderboard(window: string) {
  const gate = useOnlineQueryGate();
  return useQuery<ReferralLeaderboard>({
    queryKey: ["referrals", "leaderboard", gate.tenantId, window],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(window),
    staleTime: REFERRALS_STALE_MS,
    gcTime: REFERRALS_GC_MS,
    queryFn: async (): Promise<ReferralLeaderboard> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        `/api/v1/referrals/leaderboard?window=${encodeURIComponent(window)}&limit=20`,
      );
      return parseReferralLeaderboard(res);
    },
  });
}

/**
 * `null` data means "no programme configured" — a real answer. It is returned
 * rather than thrown so the card can say so plainly instead of rendering the
 * generic error state, which would imply something is broken.
 */
export function useReferralProgram() {
  const gate = useOnlineQueryGate();
  return useQuery<ReferralProgram | null>({
    queryKey: ["referrals", "program", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: REFERRALS_STALE_MS,
    gcTime: REFERRALS_GC_MS,
    // A 404 here is the answer, not a transient fault: retrying it three times
    // only delays saying "nothing is configured".
    retry: (failureCount, error) =>
      !isNoActiveProgramError(error) && failureCount < 2,
    queryFn: async (): Promise<ReferralProgram | null> => {
      const { client } = getClient();
      try {
        const res = await client.request<unknown>(
          "GET",
          "/api/v1/referral-programs/current",
        );
        return parseReferralProgram(res);
      } catch (error) {
        if (isNoActiveProgramError(error)) return null;
        throw error;
      }
    },
  });
}

/**
 * GET /api/v1/referrals/payouts — the milestone-reward fulfilment checklist.
 *
 * No `status` filter is passed on purpose: the phone shows the whole recent
 * ledger so the summary line can say "2 pending · 5 paid" from one request,
 * and filtering to `pending` would hide the fact that anything was ever paid.
 * The server's `total` comes back alongside the (LIMITed) rows and the summary
 * says which of the two it is describing.
 *
 * Advancing a payout is PATCH /referrals/payouts/{id} — offered to admin
 * sessions since the desktop-parity pass via `useAdvanceReferralPayout`
 * below; this query stays the read side of that pair.
 */
export function useReferralPayouts() {
  const gate = useOnlineQueryGate();
  return useQuery<ReferralPayoutList>({
    queryKey: ["referrals", "payouts", gate.tenantId],
    enabled:
      REFERRAL_RUNTIME_AVAILABLE && gate.enabled && Boolean(gate.tenantId),
    staleTime: REFERRALS_STALE_MS,
    gcTime: REFERRALS_GC_MS,
    queryFn: async (): Promise<ReferralPayoutList> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        "/api/v1/referrals/payouts?limit=50",
      );
      return parseReferralPayouts(res);
    },
  });
}

/** GET /api/v1/referrals/variants — the programme's A/B arms and their split. */
export function useReferralVariants() {
  const gate = useOnlineQueryGate();
  return useQuery<ReferralVariant[]>({
    queryKey: ["referrals", "variants", gate.tenantId],
    enabled:
      REFERRAL_RUNTIME_AVAILABLE && gate.enabled && Boolean(gate.tenantId),
    staleTime: REFERRALS_STALE_MS,
    gcTime: REFERRALS_GC_MS,
    queryFn: async (): Promise<ReferralVariant[]> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        "/api/v1/referrals/variants",
      );
      return parseReferralVariants(res);
    },
  });
}

/**
 * May this session ask for a referrer's link at all?
 *
 * The other five reads on this screen are `r.With(read)`; this one alone is
 * `r.With(admin)`, and on the session-cookie path that is an owner|admin ROLE
 * check rather than an API-key-only concern — see
 * SUBSCRIBER_REFERRAL_MINIMUM_ROLE in lib/referralsBoundary.ts for the chain
 * through `readOnlyScopes`. A viewer or editor pressing "Get link" gets a 403,
 * every time, so the card asks this first and withholds the affordance rather
 * than offering one that cannot succeed.
 *
 * `mode` is read from the auth store rather than the query gate because
 * `canAccessMinimumRole` treats an API key as a viewer-floor principal: mobile
 * cannot see which scopes a key carries, so `admin` fails closed for keys.
 */
export function useCanMintSubscriberReferral(): boolean {
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  return canAccessMinimumRole(
    SUBSCRIBER_REFERRAL_MINIMUM_ROLE,
    gate.effectiveRole,
    mode,
  );
}

/**
 * GET /api/v1/subscribers/{id}/referral — one referrer's code and share URL.
 *
 * THIS READ HAS A WRITE SIDE EFFECT. The handler calls `EnsureCode`, which
 * MINTS the subscriber's referral code on first ask. It is idempotent, but it
 * is not free, so this query is deliberately keyed on an id the caller supplies
 * only after an explicit tap, and never prefetched across a list. Passing
 * `null` keeps it disabled.
 *
 * The `enabled` clause is `subscriberReferralQueryEnabled`, a pure predicate in
 * lib/referralsBoundary.ts, rather than an inline conjunction. That is not
 * tidiness: the no-prefetch invariant is the one thing on this surface with a
 * side effect on the server's data, and inline it was untestable — the native
 * harness stubs `useQuery` itself, so no `enabled` clause in the module graph
 * is ever evaluated and a test asserting a rendered link proved nothing about
 * whether a request had fired. referralsAuthority.test.ts now exercises the
 * predicate directly in node.
 *
 * No `staleTime`: a code, once minted, is stable, and the caller only mounts
 * this while a row is expanded.
 */
export function useSubscriberReferral(subscriberId: string | null) {
  const gate = useOnlineQueryGate();
  const canMintLink = useCanMintSubscriberReferral();
  return useQuery<SubscriberReferral | null>({
    queryKey: ["referrals", "subscriber", gate.tenantId, subscriberId],
    enabled: subscriberReferralQueryEnabled({
      runtimeAvailable: REFERRAL_RUNTIME_AVAILABLE,
      gateEnabled: gate.enabled,
      tenantId: gate.tenantId,
      canMintLink,
      subscriberId,
    }),
    staleTime: REFERRALS_STALE_MS,
    gcTime: REFERRALS_GC_MS,
    queryFn: async (): Promise<SubscriberReferral | null> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        `/api/v1/subscribers/${encodeURIComponent(subscriberId ?? "")}/referral`,
      );
      return parseSubscriberReferral(res);
    },
  });
}

/** Mirrors FormsOfflineError: an honest refusal at the moment of the tap. */
export class ReferralsOfflineError extends Error {
  readonly code = "offline_write_refused";

  constructor(action: string) {
    super(`${action} needs a connection. Reconnect and try again.`);
    this.name = "ReferralsOfflineError";
  }
}

/**
 * PATCH /api/v1/referrals/payouts/{id} — advance a reward through
 * pending→approved→paid (forward-only; the server 409s anything else).
 *
 * ADMIN and ONLINE-ONLY, never queued: this records that money/goods moved
 * (or may move) toward a person, and a replay an hour later would mark a
 * fulfilment that nobody just performed. The screens gate the affordance on
 * `canAccessMinimumRole("admin", …)` and confirm before calling.
 */
export function useAdvanceReferralPayout() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      status: "approved" | "paid";
    }): Promise<unknown> => {
      if (!isProbablyOnline())
        throw new ReferralsOfflineError("Advancing a payout");
      const { client } = getClient();
      const request = payoutAdvanceRequest(input.id, input.status);
      return client.request<unknown>(request.method, request.path, {
        body: request.body,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["referrals", "payouts", tenantId],
      });
    },
  });
}

/**
 * POST /api/v1/referral-programs — the FULL-REPLACE programme save.
 *
 * The body must come from `buildReferralProgramBody` (lib/referralAdmin), so
 * it always carries the seven stored replace fields verbatim and exactly one
 * stale-write precondition. A 409 program_conflict is the precondition doing
 * its job — the sheet translates it with REFERRAL_PROGRAM_CONFLICT_MESSAGE
 * rather than as a generic failure.
 */
export function useSetReferralProgram() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (body: Record<string, unknown>): Promise<unknown> => {
      if (!isProbablyOnline())
        throw new ReferralsOfflineError("Saving the programme");
      const { client } = getClient();
      return client.request<unknown>("POST", "/api/v1/referral-programs", {
        body,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["referrals", "program", tenantId],
      });
    },
  });
}
