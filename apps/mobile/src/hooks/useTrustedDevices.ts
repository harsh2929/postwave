/**
 * hooks/useTrustedDevices.ts — AUTH#48 device trust, read + revoke.
 *
 * A trusted device is a credential that lets a BRAND NEW session start already
 * MFA-satisfied. That is a real reduction in security, approved with a hard
 * 180-day ceiling, and the condition of it shipping is that the user can SEE
 * every such credential and kill any of them from the device they always have.
 * These three verbs are that condition.
 *
 * Deliberately NOT offline-capable, for the same reason `useSessions` is not:
 * a cached list on a security screen shows stale truth about what can
 * currently skip your second factor, and revocation is inherently online. The
 * query is gated and the section renders a reconnect notice instead.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  listTrustedDevices,
  revokeAllTrustedDevices,
  revokeTrustedDevice,
  type TrustedDeviceInfo,
  type TrustedDevicesPolicy,
} from "@/api/trustedDevices";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export type { TrustedDeviceInfo, TrustedDevicesPolicy };

export const TRUSTED_DEVICES_QUERY_KEY = "auth-trusted-devices" as const;

export class TrustedDevicesApiError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "TrustedDevicesApiError";
    this.code = code;
  }
}

export function useTrustedDevices() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [
      TRUSTED_DEVICES_QUERY_KEY,
      gate.baseUrl,
      gate.tenantId,
      gate.userId,
    ],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(gate.baseUrl),
    // Security state: never serve a stale list on re-focus.
    staleTime: 0,
    queryFn: async (): Promise<TrustedDevicesPolicy> => {
      if (!gate.baseUrl) {
        throw new TrustedDevicesApiError("No workspace is connected.");
      }
      const res = await listTrustedDevices(gate.baseUrl);
      if (res.error || !res.data) {
        throw new TrustedDevicesApiError(
          res.error?.message ?? "Couldn't load your trusted devices.",
          res.error?.code,
        );
      }
      return res.data;
    },
  });
}

export function useRevokeTrustedDevice() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      if (!gate.baseUrl) {
        throw new TrustedDevicesApiError("No workspace is connected.");
      }
      const res = await revokeTrustedDevice(gate.baseUrl, id);
      if (res.error) {
        throw new TrustedDevicesApiError(
          // 404 is also what the server returns for someone else's id, so the
          // only honest reading is "it is not there any more".
          res.error.status === 404
            ? "That device was already forgotten."
            : res.error.message,
          res.error.code,
        );
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: [TRUSTED_DEVICES_QUERY_KEY],
      });
    },
  });
}

export function useRevokeAllTrustedDevices() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<number> => {
      if (!gate.baseUrl) {
        throw new TrustedDevicesApiError("No workspace is connected.");
      }
      const res = await revokeAllTrustedDevices(gate.baseUrl);
      if (res.error) {
        throw new TrustedDevicesApiError(res.error.message, res.error.code);
      }
      const count = res.data?.revoked_count;
      return typeof count === "number" && Number.isFinite(count) ? count : 0;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: [TRUSTED_DEVICES_QUERY_KEY],
      });
    },
  });
}
