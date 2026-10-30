# @postwave/query-contract

The canonical **TanStack Query key factory + staleness table** shared by Moosewave web and desktop (and adaptable by mobile).

## Why

`apps/web/src/lib/query-keys.ts` and `apps/desktop/src/lib/query-keys.ts` were copy-pasted, and mobile diverged in key shape — so a cache-key change (or a new resource) had to be hand-applied per client, and any divergence silently breaks cross-device cache correctness (the audit's data-sync finding). This package is the one place the key shape `[resource, tenantId, role, ...subkey]` and the `STALE` strategy table live.

```ts
import { qk, STALE } from "@postwave/query-contract";

useQuery({ queryKey: qk.campaigns(tenantId, role, params), staleTime: STALE.list });
queryClient.invalidateQueries({ queryKey: qk.campaign(tenantId, role, id) });
```

Tenant + role are baked into every key to prevent cross-tenant / cross-role cache leakage; `qk.authMe()` is the one identity-agnostic key.

## Adoption

Re-export from each client's existing `query-keys.ts` (`export { qk, STALE } from "@postwave/query-contract"`) so call sites don't change, then delete the duplicated bodies. Mobile adopts the same shape (its single-workspace keys become tenant-scoped), which is a one-time cache-key migration.
