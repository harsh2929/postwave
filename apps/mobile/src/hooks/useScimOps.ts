/**
 * hooks/useScimOps.ts — SCIM provisioning reads (COMMERCE#60).
 *
 * Carved out of the catch-all hooks/useOps.ts, whose own header asked each
 * remaining resource family to leave: the SCIM screen used to drag agency,
 * audit-sink and migration wire types in behind it purely because they shared
 * a file. The write half already lives in hooks/useGovernanceOps.ts.
 *
 * AUTHORIZATION. `/api/v1/scim/*` is proxied behind
 * `apikeys.RequireScope(apikeys.ScopeAdmin)`, and ScopeAdmin is absent from the
 * `readOnlyScopes` allow-list, so on the session path it resolves to a hard
 * owner/admin ROLE check — the same gate the screen itself is registered under.
 * Nothing extra is gated here; a session that reaches this screen can read
 * both lists.
 *
 * Neither query is offline-capable. A provisioning token list is a live
 * security surface: a cached copy that omits a token minted five minutes ago
 * is worse than no answer, so these fail to the error state offline rather
 * than showing a snapshot.
 */
import { useQuery } from "@tanstack/react-query";

import {
  listMobileScimRoleMappings,
  listMobileScimTokens,
  type MobileScimRoleMapping,
  type MobileScimTokenInfo,
} from "@/api/ops";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { opsTimestamp, unwrapMobileResult } from "@/lib/mobileOpsResult";

export type { MobileScimRoleMapping, MobileScimTokenInfo };

export function useMobileScimTokens() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["mobile-scim-tokens", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<MobileScimTokenInfo[]> => {
      const res = unwrapMobileResult(
        await listMobileScimTokens(),
        "SCIM tokens",
      );
      return [...(res.tokens ?? [])].sort(
        (a, b) => opsTimestamp(b.created_at) - opsTimestamp(a.created_at),
      );
    },
  });
}

/**
 * Sorted by PRECEDENCE first, not by name: precedence is the field that
 * decides which mapping actually wins for a user in two groups, so a list
 * ordered any other way cannot be read as the rule it is.
 */
export function useMobileScimRoleMappings() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["mobile-scim-role-mappings", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<MobileScimRoleMapping[]> => {
      const res = unwrapMobileResult(
        await listMobileScimRoleMappings(),
        "SCIM role mappings",
      );
      return [...(res.mappings ?? [])].sort((a, b) => {
        if (a.precedence !== b.precedence) return a.precedence - b.precedence;
        return a.group_name.localeCompare(b.group_name);
      });
    },
  });
}
