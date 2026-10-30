/**
 * hooks/useOmnichannel.ts — the two reads behind the omnichannel surface.
 *
 * VIEWER, AND NO ROLE CHECK. All three omnichannel reads are mounted behind a
 * single `RequireScope(ScopeReadCampaigns)`, which is inside the `readOnlyScopes`
 * allowlist, so `requireAdminRoleForScopes` is false and the session-role branch
 * never runs (apikeys/middleware.go:206-224, 332-349). The generated
 * `routeauth/manifest.json` independently says `session_minimum_role: "viewer"`
 * for each. Both middlewares agree, so the hook adds no role gate of its own —
 * a client-side floor above the server's would hide a surface the API is happy
 * to serve.
 *
 * THE CATALOG AND THE LIST ARE SEPARATE QUERIES WITH VERY DIFFERENT CADENCES.
 * `Catalog()` is a Go literal that touches no database and changes only when the
 * binary does (omnichannel.go:232), so it is cached for the session; the
 * definition list is rows a colleague can write from desktop at any moment, so
 * it refetches on focus like every other list in the app. Merging them into one
 * query would have made the cheap one as volatile as the expensive one.
 *
 * NOTHING POLLS. There is no dispatcher to poll: `omnichannelRuntimeQualified`
 * is `false`, so no status on any of these rows can change without a human
 * writing it on desktop. A poll would spend a request per interval to re-read a
 * row that only a person can move.
 *
 * THE DETAIL QUERY IS LAZY AND CONDITIONAL. `ListCampaigns` already returns each
 * definition's full path set (repo.go:48-52), so opening a row costs NOTHING for
 * anything inside the list's 200-row cap. `useOmnichannelCampaign` exists only
 * for the id that is NOT in the list, and stays disabled otherwise — a detail
 * fetch that re-read bytes already on screen would only give them a second
 * chance to disagree.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import {
  fetchOmnichannelCampaign,
  fetchOmnichannelCampaigns,
  fetchOmnichannelCatalog,
} from "@/api/omnichannel";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  OmniCampaignDefinition,
  OmniCatalog,
} from "@/lib/omnichannelDefinitions";

const CATALOG_KEY = "omnichannel-catalog";
const CAMPAIGNS_KEY = "omnichannel-campaigns";

/** The catalog is a build-time constant on the server. An hour is generous. */
const CATALOG_STALE_MS = 60 * 60 * 1000;
/** Definitions are written by people on desktop; a minute is the honest window. */
const CAMPAIGNS_STALE_MS = 60 * 1000;

export function omnichannelCatalogQueryKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return [CATALOG_KEY, tenantId ?? null];
}

export function omnichannelCampaignsQueryKey(
  tenantId: string | null | undefined,
  status: string | null,
): readonly unknown[] {
  return [CAMPAIGNS_KEY, tenantId ?? null, status ?? "all"];
}

export function useOmnichannelCatalog(): UseQueryResult<OmniCatalog> {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: omnichannelCatalogQueryKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: CATALOG_STALE_MS,
    queryFn: (): Promise<OmniCatalog> => fetchOmnichannelCatalog(),
  });
}

export function useOmnichannelCampaigns(
  status?: string | null,
): UseQueryResult<OmniCampaignDefinition[]> {
  const gate = useOnlineQueryGate();
  const filter = status && status !== "all" ? status : null;
  return useQuery({
    queryKey: omnichannelCampaignsQueryKey(gate.tenantId, filter),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: CAMPAIGNS_STALE_MS,
    queryFn: (): Promise<OmniCampaignDefinition[]> =>
      fetchOmnichannelCampaigns(filter ?? undefined),
  });
}

/** One definition by id. Disabled unless a caller genuinely needs the fallback. */
export function useOmnichannelCampaign(
  id: string | null | undefined,
): UseQueryResult<OmniCampaignDefinition> {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [CAMPAIGNS_KEY, gate.tenantId ?? null, "detail", id ?? null],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id),
    staleTime: CAMPAIGNS_STALE_MS,
    queryFn: (): Promise<OmniCampaignDefinition> =>
      fetchOmnichannelCampaign(id!),
  });
}
