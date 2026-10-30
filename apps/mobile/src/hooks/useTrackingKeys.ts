/**
 * hooks/useTrackingKeys.ts — list and revoke public conversion site keys.
 *
 * Both routes are admin (manifest: GET /api/v1/conversions/keys and
 * DELETE /api/v1/conversions/keys/{id}, session_minimum_role admin), so the
 * query is gated on the role and the panel renders nothing below it — an
 * empty list on a security surface would read as "no keys", which is the
 * wrong thing to imply to someone who cannot know.
 *
 * Minting (`POST /conversions/keys`) is deliberately absent: it returns the
 * plaintext key exactly once, which is credential authoring and needs a
 * capture ceremony this screen does not have. See lib/trackingKeys.
 *
 * The revoke is ONLINE-ONLY, never queued to the offline outbox: revocation
 * of a leaked credential is only worth anything at the moment it executes,
 * and a revoke that silently waits in a queue while the operator believes the
 * key is dead is the exact opposite of the reassurance the button promises.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { listTrackingKeys, revokeTrackingKey } from "@/api/trackingKeys";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";

const KEY = "conversion-tracking-keys";

export function useTrackingKeys() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled:
      gate.enabled &&
      Boolean(gate.tenantId) &&
      canAccessMinimumRole("admin", gate.effectiveRole),
    staleTime: 60_000,
    queryFn: listTrackingKeys,
  });
}

export function useRevokeTrackingKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeTrackingKey,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}
