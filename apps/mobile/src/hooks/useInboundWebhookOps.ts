/**
 * hooks/useInboundWebhookOps.ts — the whole inbound-webhook surface: the
 * endpoint LIST plus the operate half (events, replay, rotate, enable).
 *
 * The list arrived here from the catch-all hooks/useOps.ts when COMMERCE#60
 * emptied that module. The two halves have deliberately DIFFERENT offline
 * postures, and keeping them adjacent is what makes the difference legible:
 *
 *   - the LIST is offline-capable, because the one thing on this surface that
 *     is useful with no signal is the public URL you hand back to Stripe;
 *   - nothing else is, on purpose. An event replay re-executes trigger
 *     actions; a rotate mints a secret that is shown exactly once. Queued and
 *     fired later, either one acts on a world the operator has moved past.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import {
  listInboundEvents,
  replayInboundEvent,
  rotateInboundSecret,
  setInboundEndpointEnabled,
  type InboundEvent,
  type InboundEventPage,
  type InboundReplayResult,
  type InboundRotateResult,
} from "@/api/inboundWebhooks";
import { getClient } from "@/api/sdkClient";
import {
  useOnlineQueryGate,
  type OnlineQueryGate,
} from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import { loadOfflineCapableSnapshot } from "@/lib/offlineSnapshots";
import {
  vaultGetJSON,
  vaultScopeForClient,
  vaultSetJSON,
} from "@/lib/secureVault";

export type {
  InboundEvent,
  InboundEventPage,
  InboundReplayMatch,
  InboundReplayResult,
} from "@/api/inboundWebhooks";

/** Root of the endpoint LIST query key — invalidated by prefix. */
const ENDPOINTS_KEY = "inbound-webhooks";
const EVENTS_KEY = "inbound-webhook-events";

export interface InboundWebhookRow {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  /** Total events received — populated by the gateway when available. */
  eventCount?: number;
  /** Public URL the operator hands to the upstream system. */
  publicUrl?: string;
}

function publicInboundWebhookUrl(baseUrl: string, slug: string): string {
  return new URL(
    `./api/public/inbound/${encodeURIComponent(slug)}`,
    `${baseUrl.trim().replace(/\/+$/, "")}/`,
  ).toString();
}

/**
 * Vault scope for the offline snapshot: origin + tenant + human user + role.
 * Null (rather than a throw) when any part is missing, because an api-key
 * session legitimately has no human user/role boundary.
 */
function offlineSnapshotScope(gate: OnlineQueryGate) {
  const { baseUrl, tenantId, userId, effectiveRole } = gate;
  if (!baseUrl || !tenantId || !userId || !effectiveRole) return null;
  try {
    return vaultScopeForClient({
      baseUrl,
      tenantId,
      userId,
      role: effectiveRole,
    });
  } catch {
    return null;
  }
}

export function useInboundWebhooks() {
  const gate = useOnlineQueryGate();
  const baseUrl = gate.baseUrl ?? "";
  const vaultScope = offlineSnapshotScope(gate);
  return useQuery({
    queryKey: [
      ENDPOINTS_KEY,
      gate.tenantId,
      gate.userId,
      gate.effectiveRole,
      gate.enabled ? "network" : "snapshot",
    ],
    enabled:
      gate.canReadOfflineSnapshots &&
      Boolean(gate.tenantId && gate.baseUrl && vaultScope),
    networkMode: "always",
    queryFn: (): Promise<InboundWebhookRow[]> =>
      loadOfflineCapableSnapshot({
        canUseNetwork: gate.enabled,
        loadNetwork: async () => {
          const { client } = getClient();
          const res = (await client.inboundWebhooks.list()) as
            | { items?: InboundWebhookRow[] }
            | InboundWebhookRow[];
          const items = Array.isArray(res) ? res : (res.items ?? []);
          return items.map((row) => ({
            ...row,
            publicUrl:
              row.publicUrl ?? publicInboundWebhookUrl(baseUrl, row.slug),
          }));
        },
        readSnapshot: async () => {
          const cached = await vaultGetJSON<InboundWebhookRow[]>(
            "inbound-webhook",
            "latest",
            vaultScope ? { scope: vaultScope } : {},
          );
          return cached
            ? cached.map((row) => ({
                ...row,
                publicUrl:
                  row.publicUrl ?? publicInboundWebhookUrl(baseUrl, row.slug),
              }))
            : null;
        },
        writeSnapshot: (rows) =>
          vaultSetJSON("inbound-webhook", "latest", rows, {
            ...(vaultScope ? { scope: vaultScope } : {}),
          }),
        networkAvailable: isProbablyOnline,
        unavailableMessage:
          "No saved inbound-webhook snapshot is available offline.",
      }),
  });
}

/**
 * Recent events for one endpoint. `endpointId` is null while no endpoint is
 * open, which keeps the query dormant instead of fetching for a closed sheet.
 */
export function useInboundWebhookEvents(endpointId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [EVENTS_KEY, gate.tenantId, endpointId],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(endpointId),
    // A live diagnostic, not a poll: the operator pulls to refresh.
    staleTime: 15_000,
    queryFn: (): Promise<InboundEventPage> => {
      if (!endpointId) throw new Error("No endpoint selected.");
      return listInboundEvents(endpointId, 50);
    },
  });
}

export interface InboundWebhookActions {
  setEnabled: UseMutationResult<void, Error, { id: string; enabled: boolean }>;
  rotate: UseMutationResult<InboundRotateResult, Error, string>;
  replay: UseMutationResult<
    InboundReplayResult,
    Error,
    { endpointId: string; eventId: string }
  >;
}

/**
 * The three writes this surface offers. Each invalidates every view that its
 * result could have made stale, so the screen cannot keep showing the state
 * the operator just changed.
 */
export function useInboundWebhookActions(): InboundWebhookActions {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();

  // The list key above carries tenant + user + role + a snapshot marker,
  // so it is invalidated by its ROOT rather than reconstructed here — a
  // reconstructed key that drifts by one segment silently invalidates nothing.
  const invalidateEndpoints = () => {
    void qc.invalidateQueries({ queryKey: [ENDPOINTS_KEY] });
  };
  const invalidateEvents = () => {
    void qc.invalidateQueries({ queryKey: [EVENTS_KEY, gate.tenantId] });
  };

  const setEnabled = useMutation<void, Error, { id: string; enabled: boolean }>({
    mutationFn: ({ id, enabled }) => setInboundEndpointEnabled(id, enabled),
    onSuccess: invalidateEndpoints,
  });

  const rotate = useMutation<InboundRotateResult, Error, string>({
    mutationFn: (id: string) => rotateInboundSecret(id),
    onSuccess: invalidateEndpoints,
  });

  const replay = useMutation<
    InboundReplayResult,
    Error,
    { endpointId: string; eventId: string }
  >({
    mutationFn: ({ endpointId, eventId }) =>
      replayInboundEvent(endpointId, eventId),
    // A replay does not add a row to this endpoint's event feed (it re-runs
    // triggers against a STORED event), but it can change what the triggers
    // did, so the feed is refreshed rather than left frozen mid-diagnosis.
    onSuccess: invalidateEvents,
  });

  return { setEnabled, rotate, replay };
}

/** Convenience for the sheet: the newest event's timestamp, or null. */
export function latestEventAt(events: readonly InboundEvent[]): string | null {
  for (const event of events) {
    if (event.receivedAt) return event.receivedAt;
  }
  return null;
}
