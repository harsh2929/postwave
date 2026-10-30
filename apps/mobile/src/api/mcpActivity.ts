/**
 * api/mcpActivity.ts — the agent-activity monitor's three reads.
 *
 * AUTHORIZATION, READ OFF BOTH GUARDS — BECAUSE ONE OF THEM IS GENERATED AND
 * HAS ALREADY BEEN WRONG ABOUT THESE ROUTES IN THE PERMISSIVE DIRECTION.
 *
 *  1. The per-route middleware. `MountAPIKeyCallRoutes`
 *     (apps/api/internal/server/identity_api.go:111-120) builds
 *     `admin := apikeys.RequireScope(apikeys.ScopeAdmin)` and applies it to
 *     EVERY /api/v1/mcp/* route including the three reads here (:112, :115,
 *     :116). `ScopeAdmin` is NOT in `readOnlyScopes`
 *     (apikeys/middleware.go:332-337), so `requireAdminRoleForScopes` returns
 *     true and the session path runs `sessionRoleAllowsScopes`
 *     (middleware.go:300-318) — which admits owner and admin only. Editor is
 *     refused: `editorWriteScopes` is exactly {write:subscribers,
 *     write:campaigns} (middleware.go:291-294).
 *
 *  2. `routeauth.Middleware`, which evaluates the generated manifest for the
 *     whole authenticated group. Every /api/v1/mcp/* row now reads
 *     `"session_minimum_role": "admin"` from `"policy_source":
 *     "openapi.x-required-scopes"` with `"review_status": "reviewed"`
 *     (re-read 2026-09-03). It used to read `viewer` under a
 *     `safe-default:read` guess marked `fail_closed_default` — auto-generated
 *     from the HTTP verb and never checked against the handler — so the client
 *     gates on the handler's rule, which does not change when a generator runs.
 *
 * EFFECTIVE POLICY: owner/admin. Both guards say so today; only one of them
 * says it unconditionally. The handler file says so itself
 * (apps/api/internal/apikeycalls/handlers.go:10-12: "All routes require an
 * authenticated session AND owner/admin role … exposing it to viewer-tier
 * members would leak per-API-key cadence info").
 *
 * THREE ROUTES DELIBERATELY NOT CALLED FROM A PHONE:
 *   - PUT/DELETE /api/v1/mcp/quotas — per-tool daily limits are a spend
 *     control whose blast radius is every agent in the workspace. Setting one
 *     from a phone is authoring, and getting it wrong stops production traffic.
 *   - GET /api/v1/mcp/executions.csv — a file download with nowhere to go.
 *   - GET /api/v1/mcp/executions/stream — an SSE endpoint. This used to say
 *     the app "cannot consume it at all" because React Native's `fetch` has no
 *     streaming body. That is true of RN's global fetch and false of this app,
 *     which streams through `expo/fetch` (`api/sseConnect`). The endpoint is
 *     admin-only, on the stream-token allow-list, and reachable today. It stays
 *     unopened because per-tool agent cadence is a thing you go and CHECK, not
 *     a thing you watch: pull-to-refresh answers the question this screen is
 *     opened to ask, without holding a socket warm on a phone radio.
 */
import {
  normalizeMcpExecutions,
  normalizeMcpStats,
  normalizeMcpTrend,
  type McpExecution,
  type McpStats,
  type McpTrend,
  type McpWindow,
} from "@/lib/mcpActivity";
import { mcpExecutionsQuery } from "@/lib/mcpExecutionLog";

import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

/**
 * How many executions one glance reads — and one "Load older" tap adds.
 *
 * `ListExecutions` only sets `nextBeforeId` when the returned count reaches
 * the requested limit (handlers.go:98-100). The first page is this many newest
 * calls; older pages are asked for one tap at a time through
 * `api/mcpExecutionLog` and never fetched on their own. 50 is stated on
 * screen so the list is never read as "every call ever".
 */
export const MCP_EXECUTIONS_PAGE_SIZE = 50;

/** Keeps the HTTP status so the UI can tell a 403 from a 500. */
export class McpRequestError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "McpRequestError";
  }
}

async function mcpRequest<T>(path: string, label: string): Promise<T | null> {
  const res = await rawRequest<T>("GET", path, undefined);
  if (res.error) throw new McpRequestError(res.error, label);
  return res.data;
}

/**
 * True for "your role cannot see this" from either guard.
 *
 * RequireScope writes `insufficient_role`, routeauth writes its own code, and
 * both arrive as 403 — branching on the status alone is enough and does not
 * depend on which guard fired first.
 */
export function isMcpRoleDenied(error: unknown): boolean {
  return error instanceof McpRequestError
    ? error.status === 403
    : typeof error === "object" &&
        error !== null &&
        (error as { status?: unknown }).status === 403;
}

/**
 * `?include=all` widens past the MCP User-Agent filter to every API-key call.
 * The parameter is only ever SENT when widening, because the server's test is
 * `q.Get("include") != "all"` — sending `include=mcp` would be indistinguishable
 * from sending nothing, and pretending otherwise invites a later reader to
 * believe there is a third mode.
 */
function scopeParam(includeAll: boolean): string {
  return includeAll ? "&include=all" : "";
}

export async function fetchMcpStats(
  window: McpWindow,
  includeAll: boolean,
): Promise<McpStats> {
  const raw = await mcpRequest<unknown>(
    `/api/v1/mcp/stats?window=${window}${scopeParam(includeAll)}`,
    "Loading agent activity",
  );
  return normalizeMcpStats(raw);
}

export async function fetchMcpTrend(
  window: McpWindow,
  includeAll: boolean,
): Promise<McpTrend> {
  const raw = await mcpRequest<unknown>(
    `/api/v1/mcp/trend?window=${window}${scopeParam(includeAll)}`,
    "Loading the call trend",
  );
  return normalizeMcpTrend(raw);
}

/**
 * `tool` is the server's exact-match `?tool=` filter, "" for every tool. The
 * path is built by `lib/mcpExecutionLog.mcpExecutionsQuery`, which is
 * byte-identical to the two paths this function always sent when `tool` is
 * empty, and refuses a value the server would 400.
 */
export async function listMcpExecutions(
  includeAll: boolean,
  limit: number = MCP_EXECUTIONS_PAGE_SIZE,
  tool: string = "",
): Promise<McpExecution[]> {
  const raw = await mcpRequest<unknown>(
    mcpExecutionsQuery({ includeAll, limit, tool, beforeId: null }),
    "Loading recent calls",
  );
  return normalizeMcpExecutions(raw);
}
