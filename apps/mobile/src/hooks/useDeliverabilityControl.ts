/**
 * useDeliverabilityControl — the four sending-infrastructure reads.
 *
 * All four are `armed` so the collapsed control-panel card costs nothing:
 * expanding it is the press that starts the fan-out, matching desktop's
 * panel which fetches when the panel is shown. Each read owns its own
 * failure copy — one dead section must not blank the other three.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchClickTrackingPolicy,
  fetchControlDomainSetups,
  fetchRoutingPolicy,
  fetchSendingEntitlement,
  type ClickTrackingPolicy,
  type ControlDomainSetup,
  type RoutingPolicy,
  type SendingEntitlement,
} from "@/api/deliverabilityControl";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

const STALE_MS = 5 * 60_000;

export function useControlDomainSetups(armed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["control-domain-setups", gate.tenantId],
    enabled: armed && gate.enabled && Boolean(gate.tenantId),
    staleTime: STALE_MS,
    queryFn: (): Promise<ControlDomainSetup[]> => fetchControlDomainSetups(),
  });
}

export function useClickTrackingPolicy(armed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["control-click-tracking", gate.tenantId],
    enabled: armed && gate.enabled && Boolean(gate.tenantId),
    staleTime: STALE_MS,
    queryFn: (): Promise<ClickTrackingPolicy> => fetchClickTrackingPolicy(),
  });
}

export function useRoutingPolicy(armed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["control-ip-routing", gate.tenantId],
    enabled: armed && gate.enabled && Boolean(gate.tenantId),
    staleTime: STALE_MS,
    queryFn: (): Promise<RoutingPolicy> => fetchRoutingPolicy(),
  });
}

export function useSendingEntitlement(armed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["control-entitlements", gate.tenantId],
    enabled: armed && gate.enabled && Boolean(gate.tenantId),
    staleTime: STALE_MS,
    queryFn: (): Promise<SendingEntitlement> => fetchSendingEntitlement(),
  });
}
