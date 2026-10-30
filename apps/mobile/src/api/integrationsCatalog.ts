/**
 * api/integrationsCatalog.ts — the browse half of the integrations screen.
 *
 *   GET /api/v1/integrations/catalog   (handlers.go:191 mount, :215 handler)
 *
 * ROLE. The generated manifest records `session_minimum_role: "admin"` with
 * `policy_source: "family:admin"` and `review_status: "reviewed"`, and the
 * mount guard is `RequireScope(ScopeReadReports)`. The caller gates on admin,
 * the reviewed value, so a viewer never spends a request to collect a 403 and
 * then reads the resulting empty list as "the catalog is empty".
 *
 * NO QUERY PARAMS ARE SENT. The handler accepts `?q=&category=&badge=
 * &capability=` (filterCatalog, handlers.go:736) but the phone fetches the
 * unfiltered catalog once and narrows it locally with the same field set
 * (lib/integrationsCatalog). One 614-row payload beats one request per
 * keystroke, and it keeps search working against the cache while the device is
 * between bars.
 *
 * A NEW MODULE rather than an addition to api/integrations.ts: that module is
 * the CONNECTIONS surface (what IS connected), and this is the catalog (what
 * COULD be). They answer different questions from different handlers and the
 * seam keeps each file's header pointing at the route it actually serves.
 */
import {
  normalizeIntegrationsCatalog,
  type IntegrationsCatalog,
} from "@/lib/integrationsCatalog";

import { checkedApiResult, rawRequest } from "./request";

export const INTEGRATIONS_CATALOG_PATH = "/api/v1/integrations/catalog";

export async function fetchIntegrationsCatalog(): Promise<IntegrationsCatalog> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", INTEGRATIONS_CATALOG_PATH),
  );
  return normalizeIntegrationsCatalog(res.data);
}
