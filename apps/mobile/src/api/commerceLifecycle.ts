/**
 * api/commerceLifecycle.ts — the two lifecycle routes on a commerce
 * integration, kept out of `api/commerce.ts` because one of them is the only
 * fan-out WRITE this surface has.
 *
 * ROUTES (read from apps/api/internal/commerce/handlers.go:157-158 and the
 * generated policy manifest, not from a doc):
 *
 *   GET  /api/v1/commerce/integrations/{id}/lifecycle/report
 *        RequireScope(ScopeReadReports) · session_minimum_role admin
 *   POST /api/v1/commerce/integrations/{id}/lifecycle/evaluate
 *        RequireScope(ScopeAdmin)       · session_minimum_role admin
 *
 * routeauth.Middleware evaluates the manifest role INDEPENDENTLY of the
 * per-route scope, so a session must clear both: the report is admin for a
 * cookie session even though its API-key scope is the read-only one. That is
 * why the caller gates the whole section on admin rather than only the button.
 *
 * THE POST CARRIES NO BODY AND NO IDEMPOTENCY KEY. `EvaluateLifecycleTriggers`
 * takes none (handlers.go:1161) — it re-derives eligibility from the inventory
 * and price rows already imported — and it is deliberately never queued for
 * offline replay: a stale evaluation replayed hours later would mark rows
 * eligible against prices that have since moved.
 */
import {
  parseCommerceLifecycleReport,
  parseLifecycleEvaluation,
  type CommerceLifecycleReport,
  type LifecycleEvaluation,
} from "@/lib/commerceLifecycle";

import { CommerceRequestError } from "./commerce";
import { rawRequest } from "./request";

async function lifecycleRequest<T>(
  method: string,
  path: string,
  label: string,
  body?: unknown,
): Promise<T | null> {
  const res = await rawRequest<T>(method, path, body);
  if (res.error) throw new CommerceRequestError(res.error, label);
  return res.data;
}

export async function fetchCommerceLifecycleReport(
  integrationId: string,
): Promise<CommerceLifecycleReport | null> {
  const id = (integrationId ?? "").trim();
  if (!id) throw new Error("A store id is required to read its lifecycle report.");
  const raw = await lifecycleRequest<unknown>(
    "GET",
    `/api/v1/commerce/integrations/${encodeURIComponent(id)}/lifecycle/report`,
    "Loading the lifecycle report",
  );
  return parseCommerceLifecycleReport(raw);
}

/**
 * Mark qualifying back-in-stock and price-drop subscriptions eligible.
 *
 * Returns the server's acknowledgement rather than void, because the two
 * counters in it are the ONLY evidence the phone has that the write did
 * anything — and a null return here (a 200 whose body could not be parsed) is
 * reported as an unverified receipt instead of a success.
 */
export async function evaluateCommerceLifecycle(
  integrationId: string,
): Promise<LifecycleEvaluation | null> {
  const id = (integrationId ?? "").trim();
  if (!id) throw new Error("A store id is required to evaluate eligibility.");
  const raw = await lifecycleRequest<unknown>(
    "POST",
    `/api/v1/commerce/integrations/${encodeURIComponent(id)}/lifecycle/evaluate`,
    "Running the evaluation",
  );
  return parseLifecycleEvaluation(raw);
}
