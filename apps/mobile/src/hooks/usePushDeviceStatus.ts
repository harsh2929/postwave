/**
 * hooks/usePushDeviceStatus.ts — the server's answer about this installation.
 *
 * Gated three ways, and each gate is load-bearing:
 *   - `useOnlineQueryGate` (the app-wide contract): never fires from a cached
 *     session that cannot reach the server.
 *   - session mode: the endpoint is behind RequireAuthMethod(session), so an
 *     API-key install would collect a guaranteed 401.
 *   - `locallyEnabled`: if the user has push switched off on this device there
 *     is nothing to report, and asking would only spend a request to be told
 *     what the switch already says.
 *
 * `retry: false` on purpose. This is a background truth-check beside a
 * settings row, not a screen the user is waiting on; three silent retries on a
 * dead network buy nothing and delay the honest "not checked" state.
 */
import { useQuery } from "@tanstack/react-query";

import { fetchPushDeviceStatus } from "@/api/mobilePushStatus";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { PushDeviceStatusFacts } from "@/lib/pushDeliveryHealth";
import { useAuthStore } from "@/store/auth";

const KEY = "mobile-push-device-status";

export function usePushDeviceStatus(input: { locallyEnabled: boolean }) {
  const gate = useOnlineQueryGate();
  const sessionMode = useAuthStore((s) => s.mode) === "session";
  return useQuery({
    queryKey: [KEY, gate.tenantId, gate.userId],
    enabled:
      gate.enabled &&
      Boolean(gate.tenantId) &&
      sessionMode &&
      input.locallyEnabled,
    staleTime: 60_000,
    retry: false,
    queryFn: (): Promise<PushDeviceStatusFacts | null> =>
      fetchPushDeviceStatus(),
  });
}
