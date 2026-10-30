/**
 * useSendingOps — the sending throttle config plus operational status.
 *
 * Two gaps this closes.
 *
 * 1. The config read was a plain gated query, so offline it produced
 *    `data === undefined` with `isLoading`/`isError` both false — and the
 *    screen's render guard let that through, asserting no workspace cap
 *    about a compliance control it had never loaded. It is snapshot-backed
 *    now, and carries provenance so a cached read says so.
 *
 * 2. GET /api/v1/settings/sending/status carries quiet-hours and cap-authority
 *    state. Its current counter contract is explicitly unavailable, so the UI
 *    polls it without fabricating a numeric hourly meter. Desktop polls it at
 *    the same 30-second cadence — but desktop's route UNMOUNTS on navigation,
 *    and mobile's hidden sending-settings tab does not: Expo Router keeps a
 *    visited tab mounted, so an unconditional interval kept polling for the
 *    rest of the session after one visit. The caller therefore passes its
 *    screen focus, and the 30-second cadence applies only while focused.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import {
  canRunOnlineOrSnapshotQuery,
  onlineQueryAuthorityOwner,
  useOnlineQueryGate,
  type OnlineQueryGate,
} from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import {
  parseSendingStatus,
  type SendingStatus,
} from "@/lib/deliverabilityContracts";
import { sendingSettingsMatchesTenant } from "@/lib/sendingForm";
import {
  isCanonicalSendingSettingsRow,
  reconcileSendingSettingsMutation,
  setSendingSettingsOnce,
  type SendingSettingsInput,
  type SendingSettingsMutationResult,
  type SendingSettingsRow,
  type SendingSettingsWriteInput,
} from "@/lib/sendingSettingsMutation";
import {
  loadSnapshotBacked,
  snapshotScope,
  type SnapshotBacked,
} from "@/lib/deliverabilitySnapshots";

export type {
  SendingSettingsInput,
  SendingSettingsMutationResult,
  SendingSettingsRow,
  SendingSettingsWriteInput,
} from "@/lib/sendingSettingsMutation";

/**
 * Matches desktop's 30s status poll so both clients age the same way — while
 * the screen is focused. A blurred (still-mounted) tab does not poll at all.
 */
const STATUS_POLL_MS = 30_000;

export function sendingSettingsQueryKey(gate: OnlineQueryGate) {
  return [
    "sending-settings",
    onlineQueryAuthorityOwner(gate),
    gate.enabled ? "network" : "snapshot",
  ] as const;
}

export function sendingStatusQueryKey(gate: OnlineQueryGate) {
  return [
    "sending-status",
    onlineQueryAuthorityOwner(gate),
    "network",
  ] as const;
}

export function useSendingSettings() {
  const gate = useOnlineQueryGate();
  const scope = snapshotScope(gate);
  return useQuery({
    queryKey: sendingSettingsQueryKey(gate),
    enabled: canRunOnlineOrSnapshotQuery(gate),
    networkMode: "always",
    queryFn: async (): Promise<SnapshotBacked<SendingSettingsRow>> => {
      const result = await loadSnapshotBacked({
        resource: "sending-settings",
        scope,
        canUseNetwork: gate.enabled,
        loadNetwork: async () => {
          const { client } = getClient();
          return client.sendingSettings.get();
        },
        unavailableMessage:
          "No saved copy of your sending settings is available offline.",
      });
      if (
        !isCanonicalSendingSettingsRow(result.value) ||
        !sendingSettingsMatchesTenant(result.value, gate.tenantId)
      ) {
        throw new Error(
          "The saved sending-settings response was invalid or did not match the active workspace. Existing values remain protected.",
        );
      }
      return result;
    },
  });
}

/**
 * Operational cap/quiet-hours status. Online-only by design: even a future
 * qualified shared counter would be stale the moment the device sleeps.
 *
 * `focused` is the caller's `useIsFocused()`: the poll runs only while the
 * screen is on top, never for a visited tab that is merely still mounted.
 */
export function useSendingStatus({ focused }: { focused: boolean }) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: sendingStatusQueryKey(gate),
    enabled: gate.enabled && Boolean(gate.tenantId),
    refetchInterval: focused && gate.enabled ? STATUS_POLL_MS : false,
    refetchIntervalInBackground: false,
    queryFn: async (): Promise<SendingStatus> => {
      const { client } = getClient();
      const parsed = parseSendingStatus(
        await client.request<unknown>("GET", "/api/v1/settings/sending/status"),
      );
      if (!gate.tenantId || parsed.tenantId !== gate.tenantId) {
        throw new Error(
          "The sending-status response did not match the active workspace.",
        );
      }
      return parsed;
    },
  });
}

export class SendingOfflineError extends Error {
  readonly code = "offline_write_refused";

  constructor() {
    super(
      "Sending settings can only be changed while connected. Reconnect and try again.",
    );
    this.name = "SendingOfflineError";
  }
}

export function useUpdateSendingSettings() {
  const queryClient = useQueryClient();
  const gate = useOnlineQueryGate();
  const mutation = useMutation({
    retry: false,
    mutationFn: async (input: SendingSettingsWriteInput) => {
      // Compliance write: never queued to replay from a stale phone.
      if (!isProbablyOnline()) throw new SendingOfflineError();
      const { client } = getClient();
      return setSendingSettingsOnce(client, input, gate.tenantId ?? "");
    },
    onSuccess: (result) => {
      if (result.kind !== "applied") return;
      void queryClient.invalidateQueries({
        queryKey: sendingSettingsQueryKey(gate),
      });
      // The meter is derived from the cap we just changed — refresh it too, or
      // the bar keeps measuring against the previous limit.
      void queryClient.invalidateQueries({
        queryKey: sendingStatusQueryKey(gate),
      });
    },
  });
  return {
    ...mutation,
    reconcileAsync: async (
      input: SendingSettingsWriteInput,
      mutationDispatchedAt?: number,
    ): Promise<SendingSettingsMutationResult> => {
      if (!isProbablyOnline()) throw new SendingOfflineError();
      const { client } = getClient();
      return reconcileSendingSettingsMutation(
        client,
        input,
        gate.tenantId ?? "",
        mutationDispatchedAt,
      );
    },
  };
}

/** The payload that clears this workspace's cap and quiet-hours policy. */
export const CLEARED_SENDING_SETTINGS: SendingSettingsInput = {
  max_sends_per_hour: null,
  quiet_hours_start: "",
  quiet_hours_end: "",
  quiet_hours_tz: "",
  quiet_hours_per_recipient: true,
};
