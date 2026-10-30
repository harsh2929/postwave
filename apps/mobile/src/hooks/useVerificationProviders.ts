/**
 * useVerificationProviders — which vendor verifies addresses, and the two
 * changes a phone should be able to make to that.
 *
 * The READ is admin-scoped server-side (the row points at a billable
 * credential), so the caller passes `enabled` and mounts the card only for
 * admins — asking as a viewer buys a guaranteed 403.
 *
 * Both writes are ONLINE-ONLY and never queued. Enabling a vendor arms paid
 * per-address checks; disabling or removing one silently downgrades every
 * later signup and import to the free local tier. Neither is a change anyone
 * should discover happening at a moment they did not choose.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchVerificationProviders,
  removeVerificationProvider,
  setVerificationProviderEnabled,
} from "@/api/verificationProviders";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

import type { VerificationProvidersView } from "@/lib/verificationProviders";

const KEY = "verification-providers";

export function useVerificationProviders(enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    queryFn: (): Promise<VerificationProvidersView> =>
      fetchVerificationProviders(),
  });
}

export function useSetVerificationProviderEnabled() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<void, Error, { provider: string; enabled: boolean }>({
    mutationFn: (input) =>
      setVerificationProviderEnabled(input.provider, input.enabled),
    // The server re-probes the credential on every PUT, so the row's
    // last_error / last_balance can change even when the flip succeeds.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [KEY, gate.tenantId] });
      void queryClient.invalidateQueries({
        queryKey: ["verification-credits", gate.tenantId],
      });
    },
  });
}

export function useRemoveVerificationProvider() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (provider) => removeVerificationProvider(provider),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [KEY, gate.tenantId] });
    },
  });
}
