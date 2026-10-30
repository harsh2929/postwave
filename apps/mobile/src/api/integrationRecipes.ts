/**
 * api/integrationRecipes.ts — integration recipes, read-only.
 *
 *   GET /api/v1/integrations/recipes       (handlers.go:196 mount, :253 handler)
 *   GET /api/v1/integrations/recipes/{id}  (handlers.go:197 mount, :271 handler)
 *
 * ROLE. Both record `session_minimum_role: "admin"` in the generated manifest
 * (`policy_source: "family:admin"`, `review_status: "reviewed"`); the mount
 * guard is `RequireScope(ScopeReadReports)`. The hooks gate on admin so a
 * viewer's 403 never renders as "there are no recipes".
 *
 * THE APPLY ROUTE IS DELIBERATELY ABSENT FROM THIS MODULE.
 * `POST /api/v1/integrations/recipes/{id}/apply` is mounted and admin, and it
 * writes nothing: `applyRecipe` (handlers.go:297) fills a response from the
 * recipe's own static fields, hard-codes `status: "delegated"`, and returns
 * 202. Wiring it would put a button on a phone that changes nothing — see
 * lib/integrationRecipes' header for the full reasoning, and the register row
 * that says "ship reads only".
 *
 * The detail read is issued per recipe id, so the id is percent-encoded: recipe
 * ids are server-authored slugs today, but a path segment built by
 * concatenation is exactly where that assumption stops being true quietly.
 */
import {
  normalizeRecipeDetail,
  normalizeRecipeList,
  type RecipeDetail,
  type RecipeList,
} from "@/lib/integrationRecipes";
import { WireShapeError } from "@/lib/wireShapeError";

import { checkedApiResult, rawRequest } from "./request";

export const INTEGRATION_RECIPES_PATH = "/api/v1/integrations/recipes";

export function integrationRecipePath(id: string): string {
  return `${INTEGRATION_RECIPES_PATH}/${encodeURIComponent(id)}`;
}

export async function fetchIntegrationRecipes(): Promise<RecipeList> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", INTEGRATION_RECIPES_PATH),
  );
  return normalizeRecipeList(res.data);
}

/**
 * One recipe with its resolved source (and target) catalog entries.
 *
 * A 404 on either half is the server's own answer — `recipe_not_found` or
 * `recipe_source_not_found` — and arrives as a rejected promise via
 * `checkedApiResult`, so the sheet shows the failure rather than an empty
 * blueprint. A 200 whose body cannot be read as a recipe is treated the same
 * way, for the same reason.
 */
export async function fetchIntegrationRecipeDetail(
  id: string,
): Promise<RecipeDetail> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", integrationRecipePath(id)),
  );
  const detail = normalizeRecipeDetail(res.data);
  if (!detail) {
    throw new WireShapeError(
      "recipe",
      "The recipe came back in an unreadable shape.",
    );
  }
  return detail;
}
