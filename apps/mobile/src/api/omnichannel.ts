/**
 * api/omnichannel.ts — transport for cross-channel campaign DEFINITIONS.
 *
 * THE GUARDS, READ OFF THE MOUNT (omnichannel.go:143-150) RATHER THAN OFF THE
 * MANIFEST:
 *
 *   GET  /api/v1/omnichannel/catalog          RequireScope(read:campaigns)
 *   GET  /api/v1/omnichannel/campaigns        RequireScope(read:campaigns)
 *   GET  /api/v1/omnichannel/campaigns/{id}   RequireScope(read:campaigns)
 *
 * `ScopeReadCampaigns` is in the `readOnlyScopes` allowlist
 * (apikeys/middleware.go:332-337), so `requireAdminRoleForScopes` is false and
 * the session-role check never runs: ANY authenticated dashboard session
 * clears all three, viewer included. `internal/routeauth/manifest.json` agrees
 * — `session_minimum_role: "viewer"` on each — so both middlewares land on the
 * same floor here and the effective one is viewer.
 *
 * DELIBERATELY NOT HERE, and not for lack of time:
 *
 *   - POST /api/v1/omnichannel/campaigns (create) and POST .../validate. Both
 *     are `RequireScope(write:campaigns)`, and both are authoring surfaces for
 *     an object with up to ten channel paths, per-path audiences, template
 *     bindings, RCS→SMS fallback wiring and traffic weights that must total
 *     exactly 10000 basis points (omnichannel.go:355). That is a desktop form.
 *     `requestsRuntimeState` also REFUSES any create whose campaign or path
 *     status is anything but "draft" (:421), so the only thing a phone could
 *     author is an empty draft.
 *   - Everything under `.../campaigns/{id}/{dispatch,evaluate,materialize}`.
 *     They exist to be refused: the package's runtime is fail-closed by the
 *     constant `omnichannelRuntimeQualified = false` (:22) and those routes
 *     answer 503 with a non-retryable capability envelope. A phone button whose
 *     only outcome is a deliberate 503 is not a feature.
 *
 * WHY THE DETAIL ROUTE IS STILL WIRED even though the list already carries
 * paths: `ListCampaigns` caps at 200 rows (repo.go:37) and takes no cursor, so
 * a definition past that cap is reachable only by id. The list is the fast path
 * and the detail is the fallback; the hook decides which, not this module.
 *
 * Parsing lives in lib/omnichannelDefinitions so the rules are testable in the
 * node vitest environment.
 */
import {
  parseOmniCampaign,
  parseOmniCampaignList,
  parseOmniCatalog,
  type OmniCampaignDefinition,
  type OmniCatalog,
} from "@/lib/omnichannelDefinitions";

import { checkedApiResult, rawRequest } from "./request";

export const OMNICHANNEL_CATALOG_PATH = "/api/v1/omnichannel/catalog";
export const OMNICHANNEL_CAMPAIGNS_PATH = "/api/v1/omnichannel/campaigns";

export function omnichannelCampaignPath(id: string): string {
  return `${OMNICHANNEL_CAMPAIGNS_PATH}/${encodeURIComponent(id)}`;
}

export class OmnichannelShapeError extends Error {
  constructor(what: string) {
    super(`The omnichannel ${what} response was not in the expected shape.`);
    this.name = "OmnichannelShapeError";
  }
}

/**
 * The channel schema. Static per build on the server — `Catalog()` is a literal
 * (omnichannel.go:232) and touches no database — but it is still fetched rather
 * than hardcoded here, because it is the ONE place that states each channel's
 * runtime status, and a client-side copy of that would go stale silently the
 * day the runtime is qualified.
 */
export async function fetchOmnichannelCatalog(): Promise<OmniCatalog> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", OMNICHANNEL_CATALOG_PATH),
  );
  const parsed = parseOmniCatalog(res.data);
  if (!parsed) throw new OmnichannelShapeError("catalog");
  return parsed;
}

/**
 * Every definition for the tenant, newest-updated first — the ordering is in
 * the query itself (`ORDER BY updated_at DESC`, repo.go:36), so any client-side
 * sort is a re-sort of an already-deterministic list.
 *
 * `status` is passed through to the server rather than filtered locally when it
 * is set, because the server's filter is an indexed predicate and the list is
 * LIMIT 200 — filtering after the cap would silently hide rows that the filter
 * would have surfaced.
 */
export async function fetchOmnichannelCampaigns(
  status?: string,
): Promise<OmniCampaignDefinition[]> {
  const trimmed = (status ?? "").trim();
  const query = trimmed ? `?status=${encodeURIComponent(trimmed)}` : "";
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", `${OMNICHANNEL_CAMPAIGNS_PATH}${query}`),
  );
  const parsed = parseOmniCampaignList(res.data);
  if (!parsed) throw new OmnichannelShapeError("campaign list");
  return parsed;
}

/** One definition by id, for the rows the 200-row list cap cannot reach. */
export async function fetchOmnichannelCampaign(
  id: string,
): Promise<OmniCampaignDefinition> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", omnichannelCampaignPath(id)),
  );
  const parsed = parseOmniCampaign(res.data);
  if (!parsed) throw new OmnichannelShapeError("campaign");
  return parsed;
}
