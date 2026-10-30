/**
 * hooks/useSequences.ts — sequence list + detail, with cold-offline reads.
 *
 * Why this exists as a hook rather than inline `useQuery`s in the two screens:
 * `queryClient.ts`'s `shouldPersistQuery` returns false for EVERYTHING by
 * design and directs cold-offline surfaces to keep an explicit, minimised
 * vault projection instead. That is three moving parts per screen (the scope,
 * the projection, the snapshot/network discriminator in the query key), and
 * duplicating them across `sequences/index.tsx` and `sequences/[id].tsx` is how
 * they drift. The worked example this copies is
 * `useInboundWebhookOps.useInboundWebhooks`.
 *
 * What "cold offline" buys: the sequences screens previously rendered a
 * reconnect notice and NOTHING ELSE when the online gate was closed — a
 * plane, a lift, a dead cell — even though the operator had opened the same
 * journey ten minutes earlier. Now the last-seen topology is there, explicitly
 * labelled as a saved copy.
 *
 * TWO INVARIANTS, both load-bearing:
 *   1. The projection carries NO `version`, so `updateSequence`'s If-Match
 *      guard fails closed and a body-less snapshot can never become a PATCH.
 *   2. `writeSnapshot` never writes a payload that came from a snapshot or
 *      that carries an error, so a 404 can never overwrite a good projection.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteSequence,
  getSequence,
  getSequenceFunnel,
  listSequenceParticipants,
  listSequences,
  listStuckParticipants,
  normalizeSequenceListResponse,
  sequenceStepCount,
  type SequenceDetailWire,
  type SequenceListItem,
  type SequenceParticipantsPage,
  type StuckParticipantsReport,
} from "@/api/sequences";
import type { SequenceFunnelWire } from "@/lib/sequenceFunnel";
import { newOfflineOperationId } from "@/lib/offlineMutations";
import { sequenceDeleteErrorMessage } from "@/lib/sequenceDelete";
import {
  PARTICIPANTS_PAGE_SIZE,
  type ParticipantStatusFilter,
} from "@/lib/sequenceParticipants";
import type { AIApiError, AIApiResult } from "@/api/request";
import { useOnlineQueryGate, type OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import { sequencesQueryRootKey } from "@/lib/detailSeedKeys";
import { loadOfflineCapableSnapshot } from "@/lib/offlineSnapshots";
import {
  projectSequenceDetailSnapshot,
  projectSequenceListSnapshot,
  type SnapshotDetail,
  type SnapshotListRow,
} from "@/lib/sequenceSnapshot";
import { vaultGetJSON, vaultScopeForClient, vaultSetJSON } from "@/lib/secureVault";

/** Statuses that mean "this deployment does not expose the endpoint" — an
 *  honest product answer, not a fetch failure, and never a reason to discard
 *  a saved projection. */
function isUnavailableStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

/**
 * Vault scope: origin + tenant + human user + role. Null (not a throw) when
 * any part is missing, because an api-key session legitimately has no human
 * user/role boundary for a shared-device projection.
 */
function snapshotScope(gate: OnlineQueryGate): string | null {
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

export interface SequenceListPayload {
  items: SequenceListItem[];
  /** True when these rows came from the vault rather than the network. */
  fromSnapshot: boolean;
  /** A non-retryable product answer (404/405/501), surfaced not thrown. */
  error: AIApiError | null;
}

export interface SequenceDetailPayload {
  detail: SequenceDetailWire | null;
  fromSnapshot: boolean;
  error: AIApiError | null;
}

/**
 * Lift a stored projection back into the wire type the screens read.
 *
 * `trigger` / `goal` are carried through the vault as `unknown` because the
 * projection module is import-free and cannot name their types. They are
 * copied VERBATIM from a server response on the way in, so the assertion
 * restores a type that was true when it was written — it does not invent one.
 * The `snapshot` marker is dropped here; the payload's `fromSnapshot` flag is
 * the single signal the screens branch on.
 */
function detailFromSnapshot(cached: SnapshotDetail): SequenceDetailWire {
  const { snapshot: _snapshot, trigger, goal, ...rest } = cached;
  return {
    ...rest,
    ...(trigger
      ? { trigger: trigger as NonNullable<SequenceDetailWire["trigger"]> }
      : {}),
    ...(goal ? { goal: goal as NonNullable<SequenceDetailWire["goal"]> } : {}),
  };
}

function taggedError(error: AIApiError): Error {
  const err = new Error(error.message) as Error & { status?: number };
  err.status = error.status;
  return err;
}

export function useSequenceList() {
  const gate = useOnlineQueryGate();
  const scope = snapshotScope(gate);
  return useQuery({
    queryKey: [
      // Built, not spelled inline, so the sequence detail header can seed its
      // title off this exact cache (src/lib/detailSeedKeys.ts).
      ...sequencesQueryRootKey(gate.tenantId),
      gate.userId,
      gate.effectiveRole,
      gate.enabled ? "network" : "snapshot",
    ],
    // Online OR snapshot-capable. An api-key session has no human user/role,
    // so it legitimately has no vault scope — gating solely on
    // `canReadOfflineSnapshots` would disable the screen for those sessions
    // even while they are online.
    enabled:
      (gate.enabled && Boolean(gate.tenantId)) ||
      (gate.canReadOfflineSnapshots && Boolean(scope)),
    networkMode: "always",
    queryFn: (): Promise<SequenceListPayload> =>
      loadOfflineCapableSnapshot<SequenceListPayload>({
        canUseNetwork: gate.enabled,
        loadNetwork: async () => {
          const res = await listSequences();
          if (res.error) {
            if (isUnavailableStatus(res.error.status)) {
              return { items: [], fromSnapshot: false, error: res.error };
            }
            // Anything else is a fault: throw so the snapshot fallback and
            // the screen's error branch both get a chance.
            throw taggedError(res.error);
          }
          return {
            items: normalizeSequenceListResponse(res.data),
            fromSnapshot: false,
            error: null,
          };
        },
        readSnapshot: async () => {
          if (!scope) return null;
          const cached = await vaultGetJSON<SnapshotListRow[]>(
            "sequence",
            "list",
            { scope },
          );
          // `vaultGetJSON` is an unchecked cast over whatever JSON the blob
          // holds, so a projection written by an older build is a truthy
          // non-array. Treat it as "no snapshot" rather than handing the
          // screen something it will try to iterate.
          return Array.isArray(cached)
            ? { items: cached, fromSnapshot: true, error: null }
            : null;
        },
        writeSnapshot: async (payload) => {
          if (!scope || payload.fromSnapshot || payload.error) return;
          await vaultSetJSON(
            "sequence",
            "list",
            projectSequenceListSnapshot(payload.items, (row) =>
              sequenceStepCount(row as SequenceListItem),
            ),
            { scope },
          );
        },
        networkAvailable: isProbablyOnline,
        unavailableMessage:
          "No saved copy of your sequences is stored on this device yet.",
      }),
  });
}

export function useSequenceDetail(id: string | undefined) {
  const gate = useOnlineQueryGate();
  const scope = snapshotScope(gate);
  const sequenceId = id ?? "";
  return useQuery({
    queryKey: [
      "sequence",
      gate.tenantId,
      gate.userId,
      gate.effectiveRole,
      sequenceId,
      gate.enabled ? "network" : "snapshot",
    ],
    enabled:
      Boolean(sequenceId) &&
      ((gate.enabled && Boolean(gate.tenantId)) ||
        (gate.canReadOfflineSnapshots && Boolean(scope))),
    networkMode: "always",
    queryFn: (): Promise<SequenceDetailPayload> =>
      loadOfflineCapableSnapshot<SequenceDetailPayload>({
        canUseNetwork: gate.enabled,
        loadNetwork: async () => {
          const res = await getSequence(sequenceId);
          if (res.error) {
            if (isUnavailableStatus(res.error.status)) {
              return { detail: null, fromSnapshot: false, error: res.error };
            }
            throw taggedError(res.error);
          }
          return { detail: res.data, fromSnapshot: false, error: null };
        },
        readSnapshot: async () => {
          if (!scope) return null;
          const cached = await vaultGetJSON<SnapshotDetail>(
            "sequence",
            sequenceId,
            { scope },
          );
          if (!cached) return null;
          return { detail: detailFromSnapshot(cached), fromSnapshot: true, error: null };
        },
        writeSnapshot: async (payload) => {
          if (!scope || payload.fromSnapshot || payload.error) return;
          if (!payload.detail) return;
          const projected = projectSequenceDetailSnapshot(payload.detail);
          if (!projected) return;
          await vaultSetJSON("sequence", sequenceId, projected, { scope });
        },
        networkAvailable: isProbablyOnline,
        unavailableMessage:
          "No saved copy of this sequence is stored on this device yet.",
      }),
  });
}

/* ------------------------------------------------------------------ *
 * Delete
 * ------------------------------------------------------------------ */

export interface DeleteSequenceVars {
  id: string;
  /**
   * The row's current version, when the caller already holds one (the detail
   * screen does). Omitted from the LIST, whose payload carries no version at
   * all — in that case this resolves one with a GET first, because the server
   * requires If-Match and there is no other way to obtain it.
   */
  version?: number | undefined;
  /** Only used for messaging, never sent. */
  name?: string | undefined;
}

/**
 * DELETE /api/v1/voice/sequences/{id}.
 *
 * ONLINE ONLY and deliberately NOT registered in the offline mutation queue:
 * `lib/offlineQueueSafety` denies every DELETE by design, so a queued delete
 * would be dropped on replay while the UI had already reported success. The
 * caller hides the affordance while the gate is closed (`canDeleteSequence`).
 *
 * `Idempotency-Key` is still sent: a delete retried after a dropped response
 * must not turn into a 404 for a row a second request removed.
 */
export function useDeleteSequence() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: DeleteSequenceVars): Promise<void> => {
      let version = vars.version;
      if (!Number.isSafeInteger(version) || (version ?? 0) < 1) {
        // Read-then-delete. Optimistic concurrency is preserved rather than
        // bypassed: if the row moves between the two calls the server answers
        // 412 and the operator is told to refresh.
        const current = await getSequence(vars.id);
        if (current.error) {
          throw new Error(
            sequenceDeleteErrorMessage(
              current.error.status,
              current.error.message,
            ),
          );
        }
        version = current.data?.version;
      }
      if (!Number.isSafeInteger(version) || (version ?? 0) < 1) {
        throw new Error(sequenceDeleteErrorMessage(428));
      }
      const res = await deleteSequence(vars.id, {
        expectedVersion: version as number,
        idempotencyKey: newOfflineOperationId(),
      });
      if (res.error) {
        throw new Error(
          sequenceDeleteErrorMessage(res.error.status, res.error.message),
        );
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sequences", gate.tenantId] });
      void qc.invalidateQueries({ queryKey: ["sequence", gate.tenantId] });
    },
  });
}

/* ------------------------------------------------------------------ *
 * Participants + stuck report
 *
 * Both are ONLINE-ONLY reads: they are derived aggregates over
 * `sequence_funnel_events` whose whole value is being current, so a stored
 * projection of "who is stuck" would be worse than an honest reconnect
 * notice. That is the deliberate difference from the topology reads above.
 *
 * Errors are NOT thrown: the section components branch on the status through
 * `participantsSectionState` / `stuckSectionState`, which distinguish a scope
 * answer (403), a dependency outage (503), an unmounted route and — for the
 * stuck report — a 400 that means "detection is off for this sequence".
 * ------------------------------------------------------------------ */

export function useSequenceParticipants(
  id: string | undefined,
  filter: ParticipantStatusFilter,
  page: number,
) {
  const gate = useOnlineQueryGate();
  const sequenceId = id ?? "";
  return useQuery({
    queryKey: [
      "sequence-participants",
      gate.tenantId,
      sequenceId,
      filter,
      page,
    ],
    enabled: gate.enabled && Boolean(gate.tenantId && sequenceId),
    // Placeholder-free by choice: a status change is a different question, and
    // showing the previous answer under a new chip reads as a filter that did
    // nothing.
    queryFn: (): Promise<AIApiResult<SequenceParticipantsPage>> =>
      listSequenceParticipants(sequenceId, {
        ...(filter === "all" ? {} : { status: filter }),
        page,
        perPage: PARTICIPANTS_PAGE_SIZE,
      }),
  });
}

export function useStuckParticipants(
  id: string | undefined,
  enabledSection: boolean,
) {
  const gate = useOnlineQueryGate();
  const sequenceId = id ?? "";
  return useQuery({
    queryKey: ["sequence-stuck", gate.tenantId, sequenceId],
    enabled:
      enabledSection && gate.enabled && Boolean(gate.tenantId && sequenceId),
    queryFn: (): Promise<AIApiResult<StuckParticipantsReport>> =>
      listStuckParticipants(sequenceId),
  });
}

/**
 * Per-step funnel. `read:reports` + heavy-read limiter, so a token that can
 * read the topology may still be refused here — the section says which.
 */
export function useSequenceFunnel(id: string | undefined, enabled: boolean) {
  const gate = useOnlineQueryGate();
  const sequenceId = id ?? "";
  return useQuery({
    queryKey: ["sequence-funnel", gate.tenantId, sequenceId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId && sequenceId),
    // Heavy read behind a rate limiter: don't re-ask on every focus.
    staleTime: 60_000,
    queryFn: (): Promise<AIApiResult<SequenceFunnelWire>> =>
      getSequenceFunnel(sequenceId),
  });
}

/**
 * The funnel REPORT rather than the query, for callers that only render its
 * rows. Keeps the unwrapping (`data.data ?? null`) in one place instead of at
 * every consumer.
 */
export function useSequenceFunnelReport(
  id: string | undefined,
  enabled: boolean,
): SequenceFunnelWire | null {
  return useSequenceFunnel(id, enabled).data?.data ?? null;
}
