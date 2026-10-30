/**
 * useDeliverabilityVerificationPolicy — the pre-send verification gate's mode
 * and the paid-credit meter.
 *
 * The policy READ is admin-scoped server-side (which signups the workspace
 * refuses is an access-control-shaped fact), so the caller mounts the card
 * only for admins — asking as a viewer buys a guaranteed 403. Credits are a
 * viewer read.
 *
 * The mode write is ONLINE-ONLY: the gate decides which addresses enter the
 * list RIGHT NOW, and a queued flip applies a policy the operator has stopped
 * thinking about.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchVerificationCredits,
  fetchVerificationPolicy,
  setVerificationMode,
  type VerificationCredits,
  type VerificationMode,
  type VerificationPolicy,
  type VerificationPolicyEnvelope,
} from "@/api/verificationPolicy";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

const POLICY_KEY = "verification-policy";

export function useVerificationPolicy(enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [POLICY_KEY, gate.tenantId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    queryFn: (): Promise<VerificationPolicyEnvelope> =>
      fetchVerificationPolicy(),
  });
}

export function useSetVerificationMode() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<
    { policy: VerificationPolicy; warning: string },
    Error,
    { current: VerificationPolicy; gate: "forms" | "import"; mode: VerificationMode }
  >({
    mutationFn: (input) =>
      setVerificationMode(input.current, input.gate, input.mode),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [POLICY_KEY, gate.tenantId],
      });
    },
  });
}

export function useVerificationCredits() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["verification-credits", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    // The read probes the vendor for a live balance — do not hammer it.
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: (): Promise<VerificationCredits> => fetchVerificationCredits(),
  });
}
