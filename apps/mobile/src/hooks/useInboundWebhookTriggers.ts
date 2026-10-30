/**
 * hooks/useInboundWebhookTriggers.ts — the rules of one inbound endpoint and
 * the three writes against them (api/inboundWebhookTriggers.ts).
 *
 * The read is keyed per endpoint and only fires while the sheet is OPEN, so
 * closing it leaves nothing polling. Every write invalidates the tenant's
 * whole trigger cache by prefix rather than reconstructing a key — a key that
 * drifts by one segment invalidates nothing and the sheet keeps showing the
 * state the operator just changed.
 *
 * Online-only, never the offline outbox: see the api module header.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import {
  createInboundTriggerRule,
  deleteInboundTriggerRule,
  listInboundTriggerRules,
  updateInboundTriggerRule,
} from "@/api/inboundWebhookTriggers";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  InboundTriggerRule,
  TriggerRuleInput,
} from "@/lib/inboundTriggerRules";

const TRIGGERS_KEY = "inbound-webhook-triggers";

export function useInboundWebhookTriggers(
  endpointId: string | null,
  open: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [TRIGGERS_KEY, gate.tenantId, endpointId],
    enabled:
      gate.enabled && Boolean(gate.tenantId) && Boolean(endpointId) && open,
    // A live operator view, not a poll: pull-to-refresh or reopen.
    staleTime: 15_000,
    queryFn: (): Promise<InboundTriggerRule[]> => {
      if (!endpointId) throw new Error("No endpoint selected.");
      return listInboundTriggerRules(endpointId);
    },
  });
}

export interface SaveTriggerRuleVars {
  endpointId: string;
  /** Null creates; otherwise the whole input replaces the rule (desktop parity). */
  triggerId: string | null;
  input: TriggerRuleInput;
}

export interface SetTriggerActiveVars {
  endpointId: string;
  triggerId: string;
  active: boolean;
}

export interface RemoveTriggerVars {
  endpointId: string;
  triggerId: string;
}

export interface InboundTriggerRuleActions {
  save: UseMutationResult<InboundTriggerRule, Error, SaveTriggerRuleVars>;
  setActive: UseMutationResult<InboundTriggerRule, Error, SetTriggerActiveVars>;
  remove: UseMutationResult<void, Error, RemoveTriggerVars>;
}

export function useInboundTriggerRuleActions(): InboundTriggerRuleActions {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: [TRIGGERS_KEY, gate.tenantId] });
  };

  const save = useMutation<InboundTriggerRule, Error, SaveTriggerRuleVars>({
    mutationFn: ({ endpointId, triggerId, input }) =>
      triggerId
        ? updateInboundTriggerRule(endpointId, triggerId, input)
        : createInboundTriggerRule(endpointId, input),
    onSuccess: invalidate,
  });

  const setActive = useMutation<InboundTriggerRule, Error, SetTriggerActiveVars>({
    mutationFn: ({ endpointId, triggerId, active }) =>
      updateInboundTriggerRule(endpointId, triggerId, { active }),
    onSuccess: invalidate,
  });

  const remove = useMutation<void, Error, RemoveTriggerVars>({
    mutationFn: ({ endpointId, triggerId }) =>
      deleteInboundTriggerRule(endpointId, triggerId),
    onSuccess: invalidate,
  });

  return { save, setActive, remove };
}
