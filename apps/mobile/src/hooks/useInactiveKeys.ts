/**
 * useInactiveKeys — the dormant-credential report for the API-keys screen's
 * alert card.
 *
 * `GET /api/v1/inactive-keys` is mounted behind `RequireScope(ScopeAdmin)`
 * (apps/api/internal/inactive_keys/inactive_keys.go:74), which the session
 * path enforces as owner/admin — so the query is GATED on the role rather
 * than discovered through a 403, the same way useGpcSignals gates the
 * compliance card. The auth MODE is consulted too: an api_key session would
 * need the literal `admin` scope, which mobile never holds, and
 * canAccessMinimumRole treats api_key as viewer.
 *
 * The role comes from the auth store, not the gate: the same
 * `session.effectiveRole` the secondary-route guard gates the host screen on,
 * so the card and its host can never disagree about who may read.
 */
import { useQuery } from "@tanstack/react-query";

import { fetchInactiveKeys } from "@/api/inactiveKeys";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { InactiveKeysPayload } from "@/lib/inactiveKeyAlerts";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useAuthStore } from "@/store/auth";

export function inactiveKeysKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["inactive-keys", tenantId ?? null];
}

export function useInactiveKeys() {
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const role = useAuthStore((s) => s.session?.effectiveRole ?? null);
  const mayRead = canAccessMinimumRole("admin", role, mode);
  const query = useQuery<InactiveKeysPayload>({
    queryKey: inactiveKeysKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId) && mayRead,
    staleTime: 60_000,
    // A 4xx will not change on a second attempt, and the card is a monitor,
    // not a workflow — one honest failure line with its own Retry beats three
    // retries' worth of nothing.
    retry: false,
    queryFn: (): Promise<InactiveKeysPayload> => fetchInactiveKeys(),
  });
  return { mayRead, online: gate.enabled, query };
}
