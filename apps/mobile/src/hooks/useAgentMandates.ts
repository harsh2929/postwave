/**
 * hooks/useAgentMandates.ts — the agent-mandate list plus revoke.
 *
 * ONLINE-ONLY AND NEVER QUEUED, for the same reason `useApiKeys` is: a revoke
 * that sits in an offline queue is worse than no revoke at all, because the
 * operator believes an agent's authority is dead while it is still authorising
 * calls. If the device cannot reach the server, the honest answer is "this
 * hasn't happened yet".
 *
 * The list is not cached across sessions either. A mandate roster is a live
 * authority surface: a snapshot that omits a mandate granted five minutes ago
 * understates how much authority is currently delegated, which is the one
 * number this screen exists to make honest.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  listMobileAgentMandates,
  revokeMobileAgentMandate,
  type MobileAgentMandate,
} from "@/api/ops";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { unwrapMobileResult } from "@/lib/mobileOpsResult";

export type { MobileAgentMandate };

const KEY = "agent-mandates";

export function useAgentMandates() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 15_000,
    queryFn: async (): Promise<MobileAgentMandate[]> => {
      const res = unwrapMobileResult(
        await listMobileAgentMandates(),
        "agent mandates",
      );
      return res.data ?? [];
    },
  });
}

export function useRevokeAgentMandate() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (id: string) => {
      unwrapMobileResult(await revokeMobileAgentMandate(id), "revoke mandate");
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [KEY, gate.tenantId] });
    },
  });
}
