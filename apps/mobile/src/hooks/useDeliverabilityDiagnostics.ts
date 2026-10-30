/**
 * useDeliverabilityDiagnostics — the five reads the hub was missing, each
 * wrapping ONE endpoint and handing the screen a parsed, runtime-validated
 * value.
 *
 * Split from `useDeliverability.ts` for the same reason that file was split
 * from `useOps.ts`: a screen that wants the hub score should not transitively
 * pull in push-token and warm-up types. The parsers all live in the pure
 * `deliverabilityDiagnostics` module so their rules are node-testable.
 *
 * SCOPES MATTER HERE, and the hooks do not hide them. Warm-up and the
 * send-window WRITE are admin-scoped server-side (`ScopeAdmin`); ISP, bounce
 * class and the send-window READ need `read:reports`. The separate customer
 * push registry hook is exact-admin and identity-bound. The
 * caller gates the write affordance on the same role so a non-admin never sees
 * a control that can only 403.
 *
 * Endpoints (verified against apps/api, not against a doc):
 *   GET /api/v1/isp-breakdown?days=            isp_breakdown/isp_breakdown.go:67
 *   GET /api/v1/deliverability/hub/bounce-class-breakdown?window=
 *                                              deliverability_hub/handlers.go:41
 *   GET /api/v1/domain-warmup                  domain_warmup/domain_warmup.go:95
 *   GET /api/v1/domain-warmup/{domain}/today   domain_warmup/domain_warmup.go:99
 *   GET /api/v1/send-window                    send_window/send_window.go:95
 *   PUT /api/v1/send-window                    send_window/send_window.go:96
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseSendWindow,
  type SendWindowPolicy,
  type SendWindowTier,
} from "@/lib/deliverabilityControls";
import {
  parseBounceClasses,
  parseIspBreakdown,
  parseWarmupPlans,
  parseWarmupToday,
  type BounceClassBreakdown,
  type IspBreakdown,
  type WarmupPlan,
  type WarmupToday,
} from "@/lib/deliverabilityDiagnostics";

/** These reads are rollups, not live counters: five minutes is plenty. */
const ROLLUP_STALE_MS = 5 * 60_000;

/**
 * Flipping the enforcement tier is online-only, and deliberately NOT queued.
 * A queued "block → warn" that lands twenty minutes later, after the operator
 * has given up and rescheduled the campaign by hand, silently re-opens a
 * window they believe is shut. An honest refusal is the safer failure —
 * `writeFailureMessage` renders this code as its own message.
 */
export class SendWindowOfflineError extends Error {
  readonly code = "offline_write_refused";

  constructor() {
    super("Changing the send window needs a connection.");
    this.name = "SendWindowOfflineError";
  }
}

/** Which mailbox providers are we landing at, and which one is bouncing. */
export function useIspBreakdown(days = 30) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["isp-breakdown", gate.tenantId, days],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ROLLUP_STALE_MS,
    queryFn: async (): Promise<IspBreakdown> => {
      const { client } = getClient();
      return parseIspBreakdown(
        await client.request<unknown>(
          "GET",
          `/api/v1/isp-breakdown?days=${encodeURIComponent(String(days))}`,
        ),
      );
    },
  });
}

/** Why they bounced — 5.7.1 (blocked) is a different fix from 5.1.1 (gone). */
export function useBounceClasses(window: "7d" | "30d" | "90d" = "30d") {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["bounce-classes", gate.tenantId, window],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ROLLUP_STALE_MS,
    queryFn: async (): Promise<BounceClassBreakdown> => {
      const { client } = getClient();
      return parseBounceClasses(
        await client.request<unknown>(
          "GET",
          `/api/v1/deliverability/hub/bounce-class-breakdown?window=${window}`,
        ),
      );
    },
  });
}

/**
 * The warm-up plans themselves. Admin-scoped, so a non-admin session gets a
 * 403 rather than an empty list — the caller renders the difference.
 */
/**
 * Pause or resume a domain warm-up ramp.
 *
 * `PATCH /api/v1/domain-warmup/{domain}/status`, ScopeAdmin. Only
 * paused/active are reachable from here — see `warmupControlFor` for why the
 * terminal transitions stay on a desk.
 *
 * ONLINE-ONLY, NEVER QUEUED. A queued pause tells the operator a ramp has
 * stopped climbing while it keeps raising the domain's daily allowance on
 * schedule — and pausing during a reputation problem is the whole reason this
 * control exists.
 */
export function useSetWarmupStatus() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<void, Error, { domain: string; status: string }>({
    mutationFn: async ({ domain, status }) => {
      const { client } = getClient();
      await client.request<unknown>(
        "PATCH",
        `/api/v1/domain-warmup/${encodeURIComponent(domain)}/status`,
        { body: { status } },
      );
    },
    onSuccess: () => {
      // The plan list carries the status the card branches on, and `today`
      // carries the allowance the meter draws — a paused ramp changes both.
      void queryClient.invalidateQueries({
        queryKey: ["domain-warmup", gate.tenantId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["domain-warmup-today", gate.tenantId],
      });
    },
  });
}

export function useWarmupPlans(enabled = true) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["domain-warmup", gate.tenantId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    staleTime: ROLLUP_STALE_MS,
    queryFn: async (): Promise<WarmupPlan[]> => {
      const { client } = getClient();
      return parseWarmupPlans(
        await client.request<unknown>("GET", "/api/v1/domain-warmup"),
      );
    },
  });
}

/**
 * Today's allowance for ONE domain — the single number an operator checks
 * daily during a ramp. Kept fresher than the plan list because it is the
 * number that moves.
 */
export function useWarmupToday(domain: string) {
  const gate = useOnlineQueryGate();
  const target = domain.trim().toLowerCase();
  return useQuery({
    queryKey: ["domain-warmup-today", gate.tenantId, target],
    enabled: gate.enabled && Boolean(gate.tenantId) && target.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<WarmupToday> => {
      const { client } = getClient();
      return parseWarmupToday(
        await client.request<unknown>(
          "GET",
          `/api/v1/domain-warmup/${encodeURIComponent(target)}/today`,
        ),
      );
    },
  });
}

/** The tenant-wide send-window policy. `null` means none is configured. */
export function useSendWindow() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["send-window", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ROLLUP_STALE_MS,
    queryFn: async (): Promise<SendWindowPolicy | null> => {
      const { client } = getClient();
      return parseSendWindow(
        await client.request<unknown>("GET", "/api/v1/send-window"),
      );
    },
  });
}

/**
 * Flip the enforcement tier and NOTHING else.
 *
 * PUT /api/v1/send-window is a full upsert — it re-validates start/end/tz and
 * defaults `weekday_bitmap` to 126 when omitted. Sending only `{enforcement}`
 * would therefore silently rewrite a Sat/Sun-inclusive window to Mon–Fri. So
 * the whole current policy is echoed back with one field changed. The GET
 * renders `start_local` via `to_char(…,'HH24:MI')`, which is exactly the
 * `15:04` layout the PUT parses, so the round-trip is lossless.
 */
export function useSetSendWindowTier() {
  const queryClient = useQueryClient();
  const gate = useOnlineQueryGate();
  const tenantId = gate.tenantId;
  return useMutation({
    mutationFn: async (input: {
      policy: SendWindowPolicy;
      tier: SendWindowTier;
    }): Promise<SendWindowPolicy | null> => {
      if (!gate.enabled) throw new SendWindowOfflineError();
      const { client } = getClient();
      return parseSendWindow(
        await client.request<unknown>("PUT", "/api/v1/send-window", {
          body: {
            start_local: input.policy.startLocal,
            end_local: input.policy.endLocal,
            timezone: input.policy.timezone,
            weekday_bitmap: input.policy.weekdayBitmap,
            enforcement: input.tier,
          },
        }),
      );
    },
    onSuccess: (policy) => {
      // PUT returns the persisted policy, so seed the cache with the SERVER's
      // copy rather than the optimistic one — the server may normalise the
      // timezone or the bitmap and the card must show what is actually stored.
      if (policy) {
        queryClient.setQueryData(["send-window", tenantId], policy);
      }
      void queryClient.invalidateQueries({
        queryKey: ["send-window", tenantId],
      });
    },
  });
}
