/**
 * hooks/useAuditGovernance.ts — react-query around the workspace-level audit
 * governance endpoints (api/auditGovernance): the retention policy, auditor
 * portal sessions, and pending audit-access requests.
 *
 * Read cadence is deliberate per surface:
 *
 *  - RETENTION and PORTAL SESSIONS load only while the governance sheet is
 *    OPEN. Neither answers a question the log screen itself is asking, so
 *    fetching them on every audit visit would be two requests nobody reads.
 *  - ACCESS REQUESTS load whenever the screen mounts FOR AN ADMIN, because
 *    their whole value is unprompted awareness — "a teammate is waiting" is
 *    exactly the thing nobody opens a sheet to ask. The endpoint is admin-only
 *    (manifest, ScopeAdmin mount), so the query never runs for anyone the
 *    answer would 403.
 *
 * Both writes are ONLINE-ONLY and never queued:
 *  - a retention change decides what the purge job deletes;
 *  - a portal revoke only protects anything once the server has it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchAuditAccessRequests,
  fetchAuditPortalSessions,
  fetchAuditRetention,
  revokeAuditPortalSession,
  setAuditRetention,
} from "@/api/auditGovernance";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export function useAuditRetention(open: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["audit-retention", gate.tenantId],
    enabled: open && gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    retry: false,
    queryFn: fetchAuditRetention,
  });
}

export function useSetAuditRetention() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<void, Error, number | null>({
    mutationFn: (days) => setAuditRetention(days),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["audit-retention", gate.tenantId],
      });
    },
  });
}

export function useAuditPortalSessions(open: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["audit-portal-sessions", gate.tenantId],
    enabled: open && gate.enabled && Boolean(gate.tenantId),
    staleTime: 30_000,
    retry: false,
    queryFn: fetchAuditPortalSessions,
  });
}

export function useRevokeAuditPortalSession() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => revokeAuditPortalSession(id),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["audit-portal-sessions", gate.tenantId],
      });
    },
  });
}

/**
 * Pending audit-access requests — the admin awareness read.
 *
 * `enabled` MUST carry the admin verdict: the route 403s everyone else, and a
 * governance banner that is a permanent red error for non-admins would be the
 * exact "403 rendered as failure" this app's house rules forbid.
 */
export function useAuditAccessRequests(isAdmin: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["audit-access-requests", gate.tenantId],
    enabled: isAdmin && gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    retry: false,
    queryFn: fetchAuditAccessRequests,
  });
}
