/**
 * useSubscriberBestSendTime — the per-subscriber best-send-hour lookup
 * (MAP#49).
 *
 * AUTHORIZATION, verified against the handler rather than the manifest.
 * The route is mounted with
 *
 *     read := r.With(apikeys.RequireScope(ScopeReadReports, ScopeAdmin))
 *     read.Get("/api/v1/subscribers/{id}/best-send-time", …)
 *
 * (send_time_opt.go:479-487). That reads like "reports OR admin", and on the
 * API-KEY path it is. On the SESSION path it is NOT: `RequireScope` calls
 * `requireAdminRoleForScopes`, which returns true the moment ANY required
 * scope is outside the read-only allowlist — and `ScopeAdmin` is. It then
 * demands `sessionRoleAllowsScopes`, which fails for every role below
 * owner/admin (apikeys/middleware.go:206-263, 296-318).
 *
 * I ran it. Mounting the real router and driving a session request through it
 * gives 403 `insufficient_role` for viewer, member AND editor, and passes the
 * middleware for admin and owner. So this hook is gated on `admin`, and the
 * card renders nothing at all below that: a permanent "you can't see this"
 * panel on every profile would be noise, and firing the request anyway would
 * be a guaranteed 403 on every profile open.
 *
 * `mode === "api_key"` also fails `canAccessMinimumRole("admin", …)` by
 * construction — an API-key session carries no role claim — which is
 * fail-closed and matches how archive.tsx and SubscriberSuppressionCard gate
 * their admin verbs. A key holding read:reports would in fact be admitted by
 * the server; we accept that false negative rather than invent a role.
 */
import { useQuery } from "@tanstack/react-query";

import {
  getSubscriberBestSendTime,
  type SubscriberBestSendTimeResult,
} from "@/api/subscriberSendTime";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useAuthStore } from "@/store/auth";

export function subscriberBestSendTimeKey(
  tenantId: string | null | undefined,
  subscriberId: string | undefined,
): readonly unknown[] {
  return ["send-time-opt", tenantId ?? null, "subscriber", subscriberId ?? null];
}

export function useSubscriberBestSendTime(subscriberId: string | undefined) {
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const allowed = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  return useQuery({
    queryKey: subscriberBestSendTimeKey(gate.tenantId, subscriberId),
    enabled:
      gate.enabled && Boolean(gate.tenantId) && Boolean(subscriberId) && allowed,
    // The best hour moves on the timescale of a model run, not a screen open.
    staleTime: 10 * 60 * 1000,
    // `insufficient_data` is a 404 the API returns on purpose for most
    // subscribers. Retrying it three times on every profile open would be
    // three guaranteed round trips for a state that cannot change in
    // milliseconds — and the result is already a resolved value, not a throw.
    retry: false,
    queryFn: (): Promise<SubscriberBestSendTimeResult> =>
      getSubscriberBestSendTime(subscriberId!),
  });
}

/** Exposed so the card can render nothing without duplicating the policy. */
export function useCanReadBestSendTime(): boolean {
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  return canAccessMinimumRole("admin", gate.effectiveRole, mode);
}
