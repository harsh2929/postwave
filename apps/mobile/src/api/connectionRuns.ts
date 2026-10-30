/**
 * api/connectionRuns.ts — a provider family's run history.
 *
 * GET {family base}/{id}/runs, ScopeReadReports in every family — the LIST's
 * floor, so the viewer who is shown a failing row is also shown the run that
 * failed it (integration_writeback/handlers.go:69, analytics_integrations
 * :199, lead :140, review :258, loyalty :217, subscription :103, marketing
 * :113). The server caps the read at 25 rows by default (`queryInt(r,
 * "limit", 25)`) and offers no cursor, so there is no page to fetch.
 *
 * Kept out of connectionFamilies.ts on purpose (collision rule): that module
 * is the family REGISTRY, and this is a read over it.
 */
import {
  CONNECTION_FAMILIES,
  type ConnectionFamily,
} from "@/api/connectionFamilies";
import { rawRequest } from "@/api/request";
import { parseConnectionRuns, type ConnectionRun } from "@/lib/connectionRuns";

export async function fetchConnectionRuns(
  family: ConnectionFamily,
  id: string,
): Promise<ConnectionRun[]> {
  const trimmed = id.trim();
  // An empty id would address `{base}//runs`, which chi resolves elsewhere.
  if (!trimmed) throw new Error("connection id is required");
  const res = await rawRequest<unknown>(
    "GET",
    `${CONNECTION_FAMILIES[family].base}/${encodeURIComponent(trimmed)}/runs`,
  );
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
  return parseConnectionRuns(res.data);
}
