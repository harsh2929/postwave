/**
 * hooks/useReputationResponse.ts — the reads and writes behind the
 * "reputation is on fire" card.
 *
 * ONLINE-ONLY, NEVER QUEUED, and here the reason is sharper than usual: every
 * write in this file is something an operator does BECAUSE mail is going out
 * that should not be. A queued attack-mode flip or a queued suppression means
 * the operator believes sending has stopped while it continues — which is
 * strictly worse than knowing the action failed.
 *
 * The spam-trap sweep gets a long timeout and NO retry: it is a real sweep, not
 * a status read, and retrying it would start a second one.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchFirewallSettings,
  listBlocklistStatus,
  runSpamTrapSweep,
  setAttackMode,
  suppressBlocklistSubject,
} from "@/api/reputationResponse";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  BlocklistSubjectLike,
  FirewallSettingsLike,
  SpamTrapRunResult,
} from "@/lib/reputationResponse";

const FIREWALL_KEY = "firewall-settings";
const BLOCKLIST_KEY = "blocklist-status";

export function useFirewallSettings() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [FIREWALL_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 15_000,
    queryFn: (): Promise<FirewallSettingsLike | null> => fetchFirewallSettings(),
  });
}

export function useSetAttackMode() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<FirewallSettingsLike | null, Error, boolean>({
    mutationFn: (enabled) => setAttackMode(enabled),
    onSuccess: (fresh) => {
      // Seed with the server's answer: turning attack mode OFF also stamps a
      // 24-hour cooldown, and only the response knows when it ends.
      if (fresh) qc.setQueryData([FIREWALL_KEY, gate.tenantId], fresh);
      void qc.invalidateQueries({ queryKey: [FIREWALL_KEY, gate.tenantId] });
    },
  });
}

export function useBlocklistStatus() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [BLOCKLIST_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 30_000,
    // A workspace with no dedicated IPs or verified domains has nothing to
    // check and may answer 4xx. Retrying will not change that.
    retry: false,
    queryFn: (): Promise<BlocklistSubjectLike[]> => listBlocklistStatus(),
  });
}

export function useSuppressBlocklistSubject() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<
    { added: boolean },
    Error,
    { subjectType: string; subject: string }
  >({
    mutationFn: ({ subjectType, subject }) =>
      suppressBlocklistSubject(subjectType, subject),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [BLOCKLIST_KEY, gate.tenantId] });
    },
  });
}

export function useRunSpamTrapSweep() {
  return useMutation<SpamTrapRunResult, Error, void>({
    mutationFn: () => runSpamTrapSweep(),
    // Never automatic. A retry starts a SECOND sweep, and the first may still
    // be running.
    retry: false,
  });
}
