/**
 * useDeliverability — the workspace-level sender-health reads.
 *
 * These live here rather than in `useOps.ts` (a 700-line module spanning ten
 * unrelated resource domains, so every deliverability screen transitively
 * pulled in SCIM and agency types). Each hook wraps ONE endpoint and hands the
 * screen a parsed, runtime-validated value — the surrounding contracts modules
 * own the coercion so a shape drift throws honestly instead of rendering zeros.
 *
 * Endpoints (all verified against apps/api):
 *   GET  /api/v1/deliverability/hub          deliverability_hub/handlers.go:36
 *   GET  /api/v1/dns-health                  dns_health/dns_health.go:348
 *   POST /api/v1/dns-health/run-now          dns_health/dns_health.go:350 (admin)
 *   GET  /api/v1/sender-reputation           sender_reputation.go:84
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseBlocklistHits,
  parseDeliverabilityHub,
  type BlocklistHitDetail,
  type DeliverabilityHub,
} from "@/lib/deliverabilityContracts";
import {
  loadSnapshotBacked,
  snapshotScope,
  type SnapshotBacked,
} from "@/lib/deliverabilitySnapshots";
import {
  parseDnsHealth,
  parseSenderReputation,
  type DnsHealthStatus,
  type DomainReputation,
} from "@/lib/suppressionContracts";

/**
 * The hub score, breaches, blocklist hits and auto-throttle state. Snapshot
 * backed: "are we auto-throttled?" is exactly the question you want answered
 * in a basement, and the answer is small enough to keep.
 */
export function useDeliverabilityHub() {
  const gate = useOnlineQueryGate();
  const scope = snapshotScope(gate);
  return useQuery({
    queryKey: [
      "deliverability-hub",
      gate.tenantId,
      gate.userId,
      gate.effectiveRole,
      gate.enabled ? "network" : "snapshot",
    ],
    enabled: gate.canReadOfflineSnapshots,
    networkMode: "always",
    staleTime: 60_000,
    queryFn: (): Promise<SnapshotBacked<DeliverabilityHub>> =>
      loadSnapshotBacked({
        resource: "deliverability-hub",
        scope,
        canUseNetwork: gate.enabled,
        loadNetwork: async () => {
          const { client } = getClient();
          return parseDeliverabilityHub(
            await client.request<unknown>("GET", "/api/v1/deliverability/hub"),
          );
        },
        unavailableMessage:
          "No saved deliverability snapshot is available offline.",
      }),
  });
}

/**
 * Blocklist listings with their self-service delist links.
 *
 * The hub payload already carries `blocklist_hits`, but WITHOUT `delist_url`
 * and `delisting_status` (hub.go BlocklistHit vs handlers.go getBlocklistHits),
 * so the hub alone can tell an operator they are listed and give them no way
 * to act. This is the actionable copy of the same rows.
 */
export function useBlocklistHits() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["blocklist-hits", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<BlocklistHitDetail[]> => {
      const { client } = getClient();
      return parseBlocklistHits(
        await client.request<unknown>(
          "GET",
          "/api/v1/deliverability/hub/blocklist-hits",
        ),
      );
    },
  });
}

/**
 * Per-identity SPF/DKIM/DMARC state. This is a SIDE signal on the domains
 * screen, so its failure is tracked separately by the caller: a dead side
 * fetch must render "—" plus a notice, never an implied "not configured"
 * (desktop's D10 lesson).
 */
export function useDnsHealth() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["dns-health", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    queryFn: async (): Promise<DnsHealthStatus[]> => {
      const { client } = getClient();
      return parseDnsHealth(
        await client.request<unknown>("GET", "/api/v1/dns-health"),
      );
    },
  });
}

/** 0-100 score + grade per sending domain. Also a side signal. */
export function useSenderReputation() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["sender-reputation", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<DomainReputation[]> => {
      const { client } = getClient();
      return parseSenderReputation(
        await client.request<unknown>("GET", "/api/v1/sender-reputation"),
      );
    },
  });
}

/**
 * Force one DNS check tick. Admin-scoped server-side; the caller gates the
 * button on the same role so the user never sees a 403 they could have been
 * spared.
 */
export function useRunDnsCheck() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async () => {
      const { client } = getClient();
      await client.request<unknown>("POST", "/api/v1/dns-health/run-now");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dns-health", tenantId] });
      void queryClient.invalidateQueries({
        queryKey: ["custom-domains", tenantId],
      });
    },
  });
}
