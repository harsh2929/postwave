/**
 * lib/inboundRoutes.ts — parsing the inbound mail-routing ledger.
 *
 * WHAT THIS SURFACE ANSWERS. `apps/desktop/src/pages/InboundRoutes.tsx` is a
 * rule editor: the receiver endpoint with its one-shot HMAC secret, a
 * test-match panel, and a priority-ordered table with inline drag reorder and
 * type-to-confirm delete. Glob grammar, priority ordering and a reorder gesture
 * are pointer-and-keyboard work and stay on a desk. What ports is the operations
 * question — *did mail actually route, and did the actions it triggered run* —
 * because an inbound webhook that starts refusing at 02:00 silently drops every
 * reply until somebody notices.
 *
 * THE SHAPES, READ OFF THE GO SOURCE AND THE MIGRATION:
 *   - `Route`      apps/api/internal/inbound_email/routes.go:43-57
 *   - `RouteMatch` routes.go:220-228
 *   - `ActionRun`  apps/api/internal/inbound_email/action_runs.go:273-287
 *   - the CHECK that fixes the run vocabulary:
 *     infra/migrations/0194_inbound_route_v2.sql:63
 *     (`status IN ('succeeded','failed','skipped')`)
 *
 * FIVE SERVER FACTS THAT DECIDE HOW THIS SCREEN READS.
 *
 *  1. THERE IS NO GLOBAL MATCH FEED. Matches are only reachable per rule
 *     (`GET /api/v1/inbound-routes/{id}/matches`, routes.go:87). So this screen
 *     can never answer "did ALL mail route" — only "did THIS rule". Every
 *     sentence it prints is scoped to the selected rule, deliberately.
 *  2. `match_count` IS LIFETIME, `matches` IS THE NEWEST 50. The counter lives
 *     on `inbound_routes` and is incremented on every match; the match list is
 *     `ORDER BY matched_at DESC LIMIT 50` (routes.go:853-872). A rule with
 *     `match_count > 0` and an empty list has had its history pruned, which is
 *     a completely different fact from "never matched".
 *  3. `http_status` IS NULL FOR THREE OF THE FIVE ACTION KINDS. Only `webhook`
 *     and `automation_trigger` POST anywhere; `tag`, `forward` and
 *     `store_only` have no meaningful single int (migration :67-70). Rendering
 *     0 there would invent an HTTP status for an action that never made a
 *     request.
 *  4. A RUN'S `match_id` IS A SOFT FK. Match rows are retention-pruned
 *     independently of runs (migration :59-60), so "no runs for this match"
 *     has two causes — the route had no actions, or the runs are gone — and
 *     the screen says both rather than picking one.
 *  5. A DISABLED RULE KEEPS ITS HISTORY. `MatchRoutes` filters on
 *     `enabled = true` (routes.go:96-104), so a disabled rule matches nothing
 *     from the moment it is switched off while still showing every match it
 *     ever made. That is the single most misleading row on this screen if the
 *     disabled state is not carried loudly.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

/** Fixed by the migration's CHECK constraint. */
export type ActionRunStatus = "succeeded" | "failed" | "skipped" | "unknown";

export interface InboundRouteAction {
  /** tag | automation_trigger | webhook | forward | store_only. */
  kind: string;
  tag: string;
  eventType: string;
  url: string;
  to: string;
}

export interface InboundRoute {
  id: string;
  name: string;
  priority: number;
  stopOnMatch: boolean;
  enabled: boolean;
  matchRecipient: string;
  matchSubjectPrefix: string;
  matchFromDomain: string;
  actions: readonly InboundRouteAction[];
  /**
   * The `actions` array EXACTLY as the server sent it, untouched.
   *
   * Exists for one caller: the toggle payload (lib/inboundRouteToggle.ts). The
   * server's PATCH cannot preserve actions by omission — `json.Marshal` of the
   * omitted Go slice is the string "null", `'null'::jsonb IS NULL` is false in
   * SQL, so the CASE's ELSE arm writes JSON null over the column — and the
   * normalized `actions` above is LOSSY (it drops each action's `extra` map),
   * so echoing it back would strip webhook config. Only the verbatim wire
   * value is safe to echo.
   */
  rawActions: readonly unknown[];
  /** "" when the rule has never matched. */
  lastMatchedAt: string;
  /** LIFETIME counter, not the length of the match list. See fact 2. */
  matchCount: number;
  actionRetryMax: number;
}

export interface InboundRouteMatch {
  id: number;
  routeId: string;
  recipient: string;
  subject: string;
  fromEmail: string;
  matchedAt: string;
}

export interface InboundActionRun {
  id: number;
  routeId: string;
  actionIndex: number;
  actionKind: string;
  status: ActionRunStatus;
  attempts: number;
  /** null when this action kind never makes an HTTP request. See fact 3. */
  httpStatus: number | null;
  responseSnippet: string;
  errorMessage: string;
  durationMs: number;
  executedAt: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

/** Unrecognised statuses stay "unknown" rather than being re-labelled. */
export function actionRunStatusOf(status: string): ActionRunStatus {
  const value = status.trim().toLowerCase();
  if (value === "succeeded") return "succeeded";
  if (value === "failed") return "failed";
  if (value === "skipped") return "skipped";
  return "unknown";
}

export function normalizeInboundRoutes(raw: unknown): InboundRoute[] {
  const rows = record(raw).routes;
  const list = Array.isArray(rows) ? rows : Array.isArray(raw) ? (raw as unknown[]) : [];
  return list
    .map((entry) => {
      const row = record(entry);
      const actions = Array.isArray(row.actions) ? row.actions : [];
      return {
        id: str(row.id),
        name: str(row.name),
        priority: int(row.priority),
        stopOnMatch: row.stop_on_match === true,
        enabled: row.enabled === true,
        matchRecipient: str(row.match_recipient),
        matchSubjectPrefix: str(row.match_subject_prefix),
        matchFromDomain: str(row.match_from_domain),
        actions: actions.map((action) => {
          const step = record(action);
          return {
            kind: str(step.kind),
            tag: str(step.tag),
            eventType: str(step.event_type),
            url: str(step.url),
            to: str(step.to),
          };
        }),
        rawActions: actions,
        lastMatchedAt: str(row.last_matched_at),
        matchCount: int(row.match_count),
        actionRetryMax: int(row.action_retry_max),
      };
    })
    .filter((route) => route.id !== "");
}

export function normalizeInboundMatches(raw: unknown): InboundRouteMatch[] {
  const rows = record(raw).matches;
  const list = Array.isArray(rows) ? rows : Array.isArray(raw) ? (raw as unknown[]) : [];
  return list.map((entry) => {
    const row = record(entry);
    return {
      id: int(row.id),
      routeId: str(row.route_id),
      recipient: str(row.recipient),
      subject: str(row.subject),
      fromEmail: str(row.from_email),
      matchedAt: str(row.matched_at),
    };
  });
}

export function normalizeInboundActionRuns(raw: unknown): InboundActionRun[] {
  const rows = record(raw).runs;
  const list = Array.isArray(rows) ? rows : Array.isArray(raw) ? (raw as unknown[]) : [];
  return list.map((entry) => {
    const row = record(entry);
    const http = row.http_status;
    return {
      id: int(row.id),
      routeId: str(row.route_id),
      actionIndex: int(row.action_index),
      actionKind: str(row.action_kind),
      status: actionRunStatusOf(str(row.status)),
      attempts: int(row.attempts),
      // Absent (the Go pointer is nil) means this action kind makes no HTTP
      // request at all. Never coerced to 0 — see fact 3.
      httpStatus:
        typeof http === "number" && Number.isFinite(http) ? Math.trunc(http) : null,
      responseSnippet: str(row.response_snippet),
      errorMessage: str(row.error_message),
      durationMs: int(row.duration_ms),
      executedAt: str(row.executed_at),
    };
  });
}
