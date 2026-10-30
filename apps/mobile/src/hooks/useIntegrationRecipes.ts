/**
 * hooks/useIntegrationRecipes.ts — the recipe list and one recipe's blueprint.
 *
 * The list is not fetched until the section is opened, and a blueprint is not
 * fetched until a row is opened: the list carries a blueprint of its own, but
 * the detail read is what resolves the SOURCE and TARGET catalog entries, and
 * that is the part worth a round trip only when someone asks for it.
 *
 * ROLE-GATED on admin (the manifest's reviewed value for both routes) as well
 * as online-gated.
 *
 * STALENESS is an hour: recipes are assembled from Go source at request time
 * (AllRecipesForItems), so they change with a deploy.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchIntegrationRecipeDetail,
  fetchIntegrationRecipes,
} from "@/api/integrationRecipes";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { RecipeDetail, RecipeList } from "@/lib/integrationRecipes";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";

const RECIPE_STALE_MS = 3_600_000;

export function useIntegrationRecipes(wanted: boolean) {
  const gate = useOnlineQueryGate();
  const mayRead = canAccessMinimumRole("admin", gate.effectiveRole);
  return useQuery<RecipeList>({
    queryKey: ["integrations", "recipes", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId) && mayRead && wanted,
    staleTime: RECIPE_STALE_MS,
    queryFn: fetchIntegrationRecipes,
  });
}

export function useIntegrationRecipeDetail(id: string | null) {
  const gate = useOnlineQueryGate();
  const mayRead = canAccessMinimumRole("admin", gate.effectiveRole);
  return useQuery<RecipeDetail>({
    queryKey: ["integrations", "recipe", gate.tenantId, id],
    enabled: gate.enabled && Boolean(gate.tenantId) && mayRead && id !== null,
    staleTime: RECIPE_STALE_MS,
    queryFn: () => fetchIntegrationRecipeDetail(id ?? ""),
  });
}
