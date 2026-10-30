/**
 * decayClient — fetch wrapper for the Segment Decay Radar surface
 * (feature #5). Kept in its own file (not folded into segmentsClient.ts)
 * so this feature ships without mutating the shared segments client —
 * collision-safe with the concurrently-developed segment P&L feature.
 *
 * Delegates to the canonical apiRequest helper so native headers,
 * bearer/session resolution, offline policy, retry behavior, and diagnostics
 * match the rest of desktop while this feature keeps its local types.
 *
 * Routes:
 *   GET  /api/v1/segments/{id}/decay-events
 *   GET  /api/v1/segments/{id}/decay-events/{eventId}/members
 *   POST /api/v1/segments/{id}/decay-events/{eventId}/dismiss
 *   POST /api/v1/segments/{id}/decay-events/{eventId}/narrate
 *   GET  /api/v1/segments/{id}/definition-history
 */

import {
  apiRequest,
  type ApiResult,
} from "../../lib/api-client";

export interface DecayEvent {
  id: string;
  tenant_id?: string;
  segment_id: string;
  snapshot_date: string;
  anomaly_kind:
    | "size_cliff"
    | "zero_match"
    | "everyone_match"
    | "definition_changed";
  prior_count: number;
  new_count: number;
  leaver_count: number;
  entrant_count: number;
  clause_attrs?: Record<string, number>;
  narration?: string;
  narration_model?: string;
  dismissed_at?: string | null;
  audit_event_id?: number | null;
  created_at: string;
}

export interface DecayEventMember {
  subscriber_id: string;
  email: string;
  direction: "left" | "entered";
  clause_attrs?: Record<string, boolean>;
}

export interface DecayEventsPage {
  items: DecayEvent[];
  total: number;
}

export interface DecayEventMembersPage {
  items: DecayEventMember[];
  page: number;
  per_page: number;
  total: number;
  total_in_log: number;
  bounded_by_log_cap: boolean;
}

export interface DefinitionHistoryEntry {
  audit_id: number;
  at: string;
  actor_label: string;
  action: string;
  before?: unknown;
  after?: unknown;
}

export interface DefinitionHistoryPage {
  items: DefinitionHistoryEntry[];
}

async function call<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  return apiRequest<T>(path, init, { timeoutMs: 30_000 });
}

const enc = encodeURIComponent;

export const decayClient = {
  /** GET …/decay-events?undismissed=&limit= → {items, total}. */
  listDecayEvents(
    segmentId: string,
    opts: { undismissed?: boolean; limit?: number } = {},
  ): Promise<ApiResult<DecayEventsPage>> {
    const params = new URLSearchParams();
    if (opts.undismissed) params.set("undismissed", "true");
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return call<DecayEventsPage>(
      `/api/v1/segments/${enc(segmentId)}/decay-events${qs ? `?${qs}` : ""}`,
    );
  },

  /** GET …/decay-events/{eventId}/members?direction=&page=&per_page=. */
  decayEventMembers(
    segmentId: string,
    eventId: string,
    opts: {
      direction?: "left" | "entered";
      page?: number;
      perPage?: number;
    } = {},
  ): Promise<ApiResult<DecayEventMembersPage>> {
    const params = new URLSearchParams();
    if (opts.direction) params.set("direction", opts.direction);
    if (opts.page) params.set("page", String(opts.page));
    if (opts.perPage) params.set("per_page", String(opts.perPage));
    const qs = params.toString();
    return call<DecayEventMembersPage>(
      `/api/v1/segments/${enc(segmentId)}/decay-events/${enc(eventId)}/members${qs ? `?${qs}` : ""}`,
    );
  },

  /** POST …/decay-events/{eventId}/dismiss → {dismissed: true}. */
  dismissDecayEvent(
    segmentId: string,
    eventId: string,
  ): Promise<ApiResult<{ dismissed: boolean }>> {
    return call<{ dismissed: boolean }>(
      `/api/v1/segments/${enc(segmentId)}/decay-events/${enc(eventId)}/dismiss`,
      { method: "POST" },
    );
  },

  /** POST …/decay-events/{eventId}/narrate → DecayEvent (with narration). */
  narrateDecayEvent(
    segmentId: string,
    eventId: string,
  ): Promise<ApiResult<DecayEvent>> {
    return call<DecayEvent>(
      `/api/v1/segments/${enc(segmentId)}/decay-events/${enc(eventId)}/narrate`,
      { method: "POST" },
    );
  },

  /** GET …/definition-history?limit= → {items}. */
  definitionHistory(
    segmentId: string,
    opts: { limit?: number } = {},
  ): Promise<ApiResult<DefinitionHistoryPage>> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return call<DefinitionHistoryPage>(
      `/api/v1/segments/${enc(segmentId)}/definition-history${qs ? `?${qs}` : ""}`,
    );
  },
};
