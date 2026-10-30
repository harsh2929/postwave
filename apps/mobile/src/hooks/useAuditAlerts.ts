/**
 * hooks/useAuditAlerts.ts — the audit-alert rule list, one rule's firing
 * history, and the single write this surface offers.
 *
 * THE GATE. Both reads use `useOnlineQueryGate` with
 * `enabled: gate.enabled && Boolean(gate.tenantId)`, which is the app-wide
 * contract enforced by hooks/online-query-gating.test.ts. That matters more
 * than usual here: a disabled TanStack query reports `data: undefined,
 * isLoading: false, isError: false`, so without the gate term a governance
 * screen would render "No alert rules" — an all-clear — for a workspace whose
 * rules were simply never fetched.
 *
 * NO OFFLINE SNAPSHOT. The audit LOG is snapshot-backed (useAudit) because
 * reading history away from connectivity is the point of it. A rule roster is
 * different: its value is "is this detection watching RIGHT NOW", and a cached
 * answer to that question is worse than no answer. So this hook stays online-
 * only and the screen says so.
 *
 * NOTHING IS OPTIMISTIC AND NOTHING IS QUEUED. Pausing a detection is a
 * governance change; an optimistic row that flips to "Paused" and rolls back
 * has, for that moment, told an operator that a control is off when it is on.
 * The mutation is never registered in lib/offlineMutationContract, so the
 * offline queue in lib/offlineMutations never sees it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createAuditAlertRule,
  deleteAuditAlertRule,
  fetchAuditAlertFires,
  fetchAuditAlertIncidents,
  fetchAuditAlertRules,
  setAuditAlertEnabled,
  setAuditAlertNotifySlack,
} from "@/api/auditAlerts";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { AuditAlertCreateBody } from "@/lib/auditAlertCreate";
import type { AuditAlertIncidentPage } from "@/lib/auditAlertIncidents";
import type { AuditAlertFire, AuditAlertRule } from "@/lib/auditAlertRules";

const RULES_KEY = "audit-alert-rules";
const FIRES_KEY = "audit-alert-fires";
const INCIDENTS_KEY = "audit-alert-incidents";

/**
 * Rules change when a teammate edits them on desktop, and `fired_count` /
 * `last_error` are updated by the worker every tick (default 30s). Matching
 * that cadence keeps "Delivery failing" from being a stale accusation without
 * turning a roster into a poll.
 */
const RULES_STALE_MS = 30_000;

export function auditAlertRulesQueryKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return [RULES_KEY, tenantId ?? null];
}

/**
 * @param allowed `hasAuditReadScope(...) !== false` — withhold the request from
 * an actor the server has already told us lacks `audit:read`, so the screen's
 * scope notice is not preceded by a 403 in the log. `null` (unknown) still
 * fetches, matching app/(tabs)/audit.tsx, which never delays the read on a
 * scope answer that arrives at the same time.
 */
export function useAuditAlertRules(allowed = true) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: auditAlertRulesQueryKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed,
    staleTime: RULES_STALE_MS,
    queryFn: (): Promise<AuditAlertRule[]> => fetchAuditAlertRules(),
  });
}

/**
 * The per-rule firing history, fetched only while the detail sheet is open.
 * `staleTime: 0` because the sheet is opened to answer "did this actually
 * deliver?", and a cached answer to that is the wrong answer.
 */
export function useAuditAlertFires(id: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [FIRES_KEY, gate.tenantId, id ?? null],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id),
    staleTime: 0,
    queryFn: (): Promise<AuditAlertFire[]> => fetchAuditAlertFires(id!),
  });
}

/**
 * The external tickets one rule has opened.
 *
 * A SEPARATE READ FROM `fires`, AND A DIFFERENT QUESTION. `fires` says the rule
 * matched and we attempted delivery; `incidents` says a ticket exists in
 * ServiceNow / Jira / PagerDuty and carries the status that system has synced
 * back through `InboundWebhook`. A rule can have delivered perfectly and still
 * have four incidents nobody has touched — which is the one thing on this
 * surface worth interrupting someone for, and it is invisible in `fires`.
 *
 * `staleTime: 0` for the same reason the fire history uses it: the sheet is
 * opened to answer "is anything still open right now".
 */
export function useAuditAlertIncidents(id: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [INCIDENTS_KEY, gate.tenantId, id ?? null],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id),
    staleTime: 0,
    queryFn: (): Promise<AuditAlertIncidentPage> =>
      fetchAuditAlertIncidents(id!),
  });
}

export interface AuditAlertToggleInput {
  id: string;
  enabled: boolean;
}

export function useToggleAuditAlert() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<void, Error, AuditAlertToggleInput>({
    mutationFn: ({ id, enabled }) => setAuditAlertEnabled(id, enabled),
    onSuccess: () => {
      // The list carries `enabled`, and resuming a rule immediately changes
      // what its fire history will say, so both reads are stale on success.
      void qc.invalidateQueries({
        queryKey: auditAlertRulesQueryKey(gate.tenantId),
      });
      void qc.invalidateQueries({ queryKey: [FIRES_KEY, gate.tenantId] });
    },
  });
}

/**
 * Flip the managed-Slack fan-out on one rule. Same governance discipline as
 * the pause toggle: online-only, never optimistic, never queued — a switch
 * that shows "routed to Slack" and rolls back has told the on-call the noise
 * went somewhere it did not.
 */
export function useSetAuditAlertNotifySlack() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<void, Error, { id: string; notifySlack: boolean }>({
    mutationFn: ({ id, notifySlack }) => setAuditAlertNotifySlack(id, notifySlack),
    onSuccess: () => {
      // Only the list carries `notify_slack`; the fire history is untouched.
      void qc.invalidateQueries({
        queryKey: auditAlertRulesQueryKey(gate.tenantId),
      });
    },
  });
}

/**
 * Stand up a new watch condition. Online-only: the body carries a channel
 * credential typed moments ago, and replaying that from a queue later — after
 * the operator has stopped thinking about it — is exactly the out-of-context
 * write the offline outbox exists to refuse.
 */
export function useCreateAuditAlert() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<string, Error, AuditAlertCreateBody>({
    mutationFn: (body) => createAuditAlertRule(body),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: auditAlertRulesQueryKey(gate.tenantId),
      });
    },
  });
}

/**
 * Retire a rule for good. Never queued for the same reason a pause is not —
 * and additionally unrecoverable in one specific sense the confirm states:
 * the server redacts `channel_config` on every read, so the credential set the
 * rule carried cannot be read back from this app.
 */
export function useDeleteAuditAlert() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => deleteAuditAlertRule(id),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: auditAlertRulesQueryKey(gate.tenantId),
      });
      void qc.invalidateQueries({ queryKey: [FIRES_KEY, gate.tenantId] });
      void qc.invalidateQueries({ queryKey: [INCIDENTS_KEY, gate.tenantId] });
    },
  });
}
