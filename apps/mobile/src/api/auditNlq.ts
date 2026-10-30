/**
 * api/auditNlq.ts — the two audit natural-language endpoints.
 *
 * Verified against apps/api/internal/handlers/audit_nlq.go and the mount site
 * apps/api/internal/server/audit_operations.go:50-51:
 *
 *   POST /api/v1/audit/nlq              { query }
 *        → { query_preview, structured_filters, invalid_fields, results,
 *            total_count, summary, trace, cost_status }
 *        Mount gate `apikeys.RequireScope(ScopeAuditRead)`; routeauth manifest
 *        row is STRICTER — session_minimum_role `admin`, api_key scope
 *        `audit:execute_actions` — and the stricter of the two binds. See
 *        lib/auditNlq's `auditNlqAccess` for the client-side consequence.
 *
 *   GET  /api/v1/audit/nlq/cost-status
 *        → { daily_usage_tokens, daily_cap_tokens, remaining_tokens,
 *            reset_at, nlq_available }
 *        routeauth row: session_minimum_role `viewer`.
 *
 * `results` carries the SAME `handlers.AuditRow` JSON shape the list returns,
 * but from a NARROWER projection — no redactedFields / legalHold /
 * hasEncryptedMetadata / sessionId. lib/auditNlq's header explains why that
 * changes how a result row may be drawn.
 *
 * Parsing lives in lib/auditNlq so the display rules are testable under node.
 * This module is transport only.
 */
import { getClient } from "@/api/client";
import {
  parseAuditNlqAnswer,
  parseAuditNlqAvailability,
  parseAuditNlqBudget,
  type AuditNlqAnswer,
  type AuditNlqBudget,
} from "@/lib/auditNlq";

export const AUDIT_NLQ_PATH = "/api/v1/audit/nlq";
export const AUDIT_NLQ_COST_STATUS_PATH = "/api/v1/audit/nlq/cost-status";

export interface AuditNlqCostStatus {
  budget: AuditNlqBudget;
  /** `h.NLQLLM != nil` on the server, or null on a gateway that omits it. */
  available: boolean | null;
}

export async function fetchAuditNlqCostStatus(): Promise<AuditNlqCostStatus> {
  const { client } = getClient();
  const res = await client.request<unknown>("GET", AUDIT_NLQ_COST_STATUS_PATH);
  return {
    budget: parseAuditNlqBudget(res),
    available: parseAuditNlqAvailability(res),
  };
}

export async function askAuditNlq<Row>(
  query: string,
): Promise<AuditNlqAnswer<Row>> {
  const { client } = getClient();
  const res = await client.request<unknown>("POST", AUDIT_NLQ_PATH, {
    body: { query: query.trim() },
  });
  return parseAuditNlqAnswer<Row>(res);
}
