/**
 * hooks/useScimMappingOps.ts — SCIM role-mapping mutations.
 *
 * A SEPARATE MODULE from hooks/useScimOps on purpose: the jest routes config
 * proxies useScimOps as a pure query-hook module (its own comment forbids
 * adding mutations to proxied modules), so the write half lives here — the
 * same split COMMERCE#60 made for other resource families.
 *
 * Both mutations invalidate ["mobile-scim-role-mappings"] — the exact key
 * useMobileScimRoleMappings reads — so the precedence-ordered list re-sorts
 * with the server's stored truth rather than an optimistic guess.
 *
 * ONLINE-ONLY (api/scimMappings.ts), so both run in network mode "always":
 * react-query's default would PAUSE a write started offline and replay it on
 * reconnect — granting or revoking a role for a whole IdP group after the
 * operator stopped looking. Now it fails into the caller's onError.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  deleteScimRoleMapping,
  upsertScimRoleMapping,
  type UpsertScimMappingInput,
} from "@/api/scimMappings";

const MAPPINGS_KEY = "mobile-scim-role-mappings";

export function useUpsertScimMapping() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertScimMappingInput) => upsertScimRoleMapping(input),
    networkMode: "always",
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [MAPPINGS_KEY] });
    },
  });
}

export function useDeleteScimMapping() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteScimRoleMapping(id),
    networkMode: "always",
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [MAPPINGS_KEY] });
    },
  });
}
