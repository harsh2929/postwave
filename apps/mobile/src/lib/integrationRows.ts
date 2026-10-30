/**
 * lib/integrationRows.ts — parsing the integrations connection feed.
 *
 * This is the riskiest logic in the commerce cluster and it had no tests: a
 * three-way envelope unwrap, a "does this tenant actually use it" filter that
 * decides whether 600 catalog rows or 6 real ones reach the screen, and a
 * health-state mapping whose unknown-value fallback must never resolve to a
 * false "healthy". Pulled out of the hook so all three are unit-testable
 * without React.
 *
 * Two behaviours worth stating because they were bugs:
 *
 *  - NAME IS NOT A SLUG. The screen used to title-case whatever it got, which
 *    turned the catalog's correctly-cased display name "eBay" into "EBay".
 *    `name` is now carried verbatim and `slug` kept separately, so the only
 *    thing that ever gets title-cased is an actual slug.
 *  - THE SERVER SENDS MORE THAN WE KEPT. `manage_path` (where to finish the
 *    job on the web admin) and `health_message` (the human-readable
 *    counterpart to the raw provider error) were both on the wire and both
 *    discarded. Keeping them is what lets a failing row offer a next step
 *    instead of a dead end.
 */

export type IntegrationStatus = "healthy" | "degraded" | "failing";

export interface Integration {
  id: string;
  /** Catalog slug — stable, lowercase, safe for a URL path. */
  slug: string;
  /** Display name exactly as the catalog spells it ("eBay", "HubSpot"). */
  name: string;
  status: IntegrationStatus;
  category?: string | undefined;
  last_delivery_at?: string | undefined;
  last_error?: string | undefined;
  /** Human-readable health summary from the server. */
  health_message?: string | undefined;
  /** Relative path to the web-admin surface that manages this connection. */
  manage_path?: string | undefined;
  /**
   * The provider-row id every lifecycle verb needs.
   *
   * `primary_connection_id` / `connection_ids` are on the wire already — the Go
   * Connection struct declares both (integrations/handlers.go:54-55) and
   * applyRuntimeConnectionIDs populates them on the LIST path (:465) — and this
   * normalizer dropped them. That single omission is why the phone could see an
   * integration failing and do nothing about it: retry, pause, resume and
   * disconnect all address a connection by id
   * (e.g. POST /api/v1/crm/integrations/{id}/sync), and the id never reached the
   * client. Carrying it does not by itself add a verb, but no verb is reachable
   * without it.
   */
  primary_connection_id?: string | undefined;
  /** Every connection id for this slug; a tenant may hold more than one. */
  connection_ids?: readonly string[] | undefined;
}

/**
 * Map the gateway's `Connection.health_state` ("healthy" | "needs_attention" |
 * "action_required" | "ready_to_configure" | "not_configured" | "planned")
 * onto the screen's three-state union. A connection with a live error
 * (action_required) is "failing"; anything saved-but-not-clean is "degraded";
 * only an explicit "healthy" is healthy. Unknown values fall back to
 * "degraded" so a new server state can never read as a false all-clear.
 */
export function healthStateToStatus(state: string): IntegrationStatus {
  const s = String(state ?? "").toLowerCase();
  if (s === "healthy") return "healthy";
  if (s === "action_required") return "failing";
  return "degraded";
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Every usable string in an array field; tolerant of a non-array or junk entries. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry !== "");
}

/** Unwrap the three shapes the connections endpoint has been seen to return. */
function unwrapItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const env = payload as { items?: unknown; integrations?: unknown };
  if (Array.isArray(env.items)) return env.items;
  if (Array.isArray(env.integrations)) return env.integrations;
  return [];
}

/**
 * Project the connections payload onto the rows the health screen renders.
 *
 * The endpoint returns the ENTIRE catalog (hundreds of not-configured and
 * roadmap rows), so anything with no tenant footprint — not connected, no
 * count, no error — is dropped. Without that filter the health counters would
 * be swamped and the empty state would never appear.
 */
export function normalizeIntegrationRows(payload: unknown): Integration[] {
  const arr = unwrapItems(payload);
  const out: Integration[] = [];
  for (let i = 0; i < arr.length; i += 1) {
    const r = (arr[i] ?? {}) as Record<string, unknown>;
    const connected = r.connected === true;
    const count = typeof r.count === "number" ? r.count : 0;
    const lastError = str(r.last_error);
    if (!connected && count <= 0 && lastError === "") continue;

    const slug = str(r.slug);
    const name = str(r.name);
    const category = str(r.category);
    const healthMessage = str(r.health_message);
    const managePath = str(r.manage_path);
    const connectionIds = stringList(r.connection_ids);
    // Fall back to the first of the list: the server omits primary_connection_id
    // when a tenant holds exactly one connection for a slug, and a verb addressed
    // at that single row is unambiguous.
    const primaryConnectionId =
      str(r.primary_connection_id) || (connectionIds[0] ?? "");
    out.push({
      id: slug || str(r.id) || `integration-${i}`,
      slug,
      // Verbatim display name; only fall back through slug/category when the
      // server genuinely sent none.
      name: name || slug || category || "Integration",
      status: healthStateToStatus(String(r.health_state ?? "")),
      ...(category ? { category } : {}),
      ...(typeof r.last_sync_at === "string"
        ? { last_delivery_at: r.last_sync_at }
        : {}),
      ...(lastError ? { last_error: lastError } : {}),
      ...(healthMessage ? { health_message: healthMessage } : {}),
      ...(managePath ? { manage_path: managePath } : {}),
      ...(primaryConnectionId
        ? { primary_connection_id: primaryConnectionId }
        : {}),
      ...(connectionIds.length > 0 ? { connection_ids: connectionIds } : {}),
    });
  }
  return out;
}

export interface IntegrationCounts {
  failing: number;
  degraded: number;
  healthy: number;
}

export function countByStatus(
  rows: readonly Integration[],
): IntegrationCounts {
  const counts: IntegrationCounts = { failing: 0, degraded: 0, healthy: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/**
 * Title-case a slug for display when — and only when — no display name came
 * back. Never applied to `name`, which the catalog already spells correctly.
 */
export function titleCaseSlug(slug: string): string {
  const trimmed = (slug ?? "").trim();
  if (!trimmed) return "Integration";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Resolve a server-supplied `manage_path` against the workspace base URL.
 * Returns null for anything that is not a same-origin http(s) destination, so
 * a hostile or malformed value cannot be handed to `Linking.openURL`.
 */
export function manageUrl(
  managePath: string | undefined,
  baseUrl: string | null | undefined,
): string | null {
  if (!managePath || !baseUrl) return null;
  let resolved: URL;
  let base: URL;
  try {
    base = new URL(baseUrl);
    resolved = new URL(managePath, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return null;
  if (resolved.hostname.toLowerCase() !== base.hostname.toLowerCase()) return null;
  return resolved.toString();
}
