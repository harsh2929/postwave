/**
 * lib/integrationRecipes.ts — integration RECIPES: the list, and one recipe's
 * blueprint.
 *
 *   GET /api/v1/integrations/recipes        → {items: Recipe[], summary}
 *   GET /api/v1/integrations/recipes/{id}   → {recipe, source, target?}
 *
 * A recipe is a named wiring between a provider and a Moosewave surface —
 * "Shopify orders → Moosewave commerce events" — carrying a BLUEPRINT: the
 * trigger, the destination, the Moosewave surface that owns it, the scopes and
 * secrets it needs, the events it moves, and the field mappings. That is
 * exactly the reference a person wants away from a desk, and it is what the
 * desktop's recipe controller reads (useIntegrationRecipeController.ts:80).
 *
 * ── WHY THERE IS NO `apply` HERE ───────────────────────────────────────────
 * `POST /api/v1/integrations/recipes/{id}/apply` exists and is admin. It also
 * WRITES NOTHING. The handler (handlers.go:297 applyRecipe) looks the recipe
 * up, fills a response from the recipe's own static fields, hard-codes
 * `status: "delegated"` and the sentence "Open the owning Moosewave surface and
 * configure this recipe with the provided blueprint", and answers 202. There
 * is no branch that touches a pool, a tenant, or a row.
 *
 * So an "Apply" button on a phone would be a button that does nothing — the
 * precise failure the integrations screen's own header already records for the
 * per-slug lifecycle routes ("a 'Retry sync' button here would be a button
 * that does nothing"). It is also the STARTING half of a capability under
 * lib/stoppingHalfPolicy: configuring a recipe means credentials and a form.
 * Both rules point the same way, and the register's row says the same thing —
 * "ship reads only". What the phone renders instead is the blueprint the apply
 * response would have echoed, plus the honest hand-off to the surface that
 * owns it.
 *
 * IMPORTS ONLY `lib/direction`, which is itself import-free, so this module
 * still runs under the node vitest environment.
 */
import { transitionLabel } from "@/lib/direction";

export interface RecipeStep {
  title: string;
  description: string;
  action: string;
  path: string;
  requiredFields: string[];
}

export interface RecipeFieldMapping {
  source: string;
  target: string;
  required: boolean;
  description: string;
}

export interface RecipeBlueprint {
  trigger: string;
  destination: string;
  postwaveSurface: string;
  requiredScopes: string[];
  requiredSecrets: string[];
  events: string[];
  dataHandling: string[];
  fieldMappings: RecipeFieldMapping[];
}

export interface RecipeRow {
  id: string;
  name: string;
  provider: string;
  sourceSlug: string;
  targetSlug: string;
  summary: string;
  /** Server badge token, verbatim — the same vocabulary the catalog uses. */
  badge: string;
  /** The server's own word for "this recipe can be run today". */
  available: boolean;
  estimatedMinutes: number | null;
  setupPath: string;
  capabilities: string[];
  steps: RecipeStep[];
  blueprint: RecipeBlueprint;
}

export interface RecipeList {
  items: RecipeRow[];
  /** The server's own counts: total, available, planned, badge:*, provider:*. */
  summary: Record<string, number>;
}

export interface RecipeDetail {
  recipe: RecipeRow;
  /** The catalog entry the recipe reads from, as the server resolved it. */
  sourceName: string;
  sourceStatus: string;
  /** Empty when the recipe has no target integration. */
  targetName: string;
  targetStatus: string;
}

export const RECIPE_PAGE_SIZE = 20;
export const RECIPE_MAX_SEARCH_CHARS = 256;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const s = str(entry);
    if (s) out.push(s);
  }
  return out;
}

function objRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row) => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    .map((row) => row as Record<string, unknown>);
}

function blueprint(value: unknown): RecipeBlueprint {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    trigger: str(raw.trigger),
    destination: str(raw.destination),
    postwaveSurface: str(raw.postwave_surface),
    requiredScopes: strList(raw.required_scopes),
    requiredSecrets: strList(raw.required_secrets),
    events: strList(raw.events),
    dataHandling: strList(raw.data_handling),
    fieldMappings: objRows(raw.field_mappings)
      .map((row) => ({
        source: str(row.source),
        target: str(row.target),
        required: row.required === true,
        description: str(row.description),
      }))
      .filter((mapping) => mapping.source !== "" || mapping.target !== ""),
  };
}

function recipeRow(value: unknown): RecipeRow | null {
  const raw = (value ?? {}) as Record<string, unknown>;
  const id = str(raw.id);
  const name = str(raw.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    provider: str(raw.provider),
    sourceSlug: str(raw.source_slug),
    targetSlug: str(raw.target_slug),
    summary: str(raw.summary),
    badge: str(raw.badge),
    // `available` is the server's boolean, and only `true` counts. An absent
    // field means "the server did not say it is runnable", which must read as
    // not-runnable rather than as a default yes.
    available: raw.available === true,
    estimatedMinutes: numOrNull(raw.estimated_minutes),
    setupPath: str(raw.setup_path),
    capabilities: strList(raw.capabilities),
    steps: objRows(raw.steps)
      .map((row) => ({
        title: str(row.title),
        description: str(row.description),
        action: str(row.action),
        path: str(row.path),
        requiredFields: strList(row.required_fields),
      }))
      .filter((step) => step.title !== "" || step.description !== ""),
    blueprint: blueprint(raw.blueprint),
  };
}

export function normalizeRecipeList(payload: unknown): RecipeList {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const items: RecipeRow[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(raw.items) ? raw.items : []) {
    const row = recipeRow(value);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    items.push(row);
  }
  const summary: Record<string, number> = {};
  const rawSummary = raw.summary;
  if (rawSummary && typeof rawSummary === "object" && !Array.isArray(rawSummary)) {
    for (const [key, value] of Object.entries(
      rawSummary as Record<string, unknown>,
    )) {
      const n = numOrNull(value);
      if (n !== null) summary[key] = n;
    }
  }
  return { items, summary };
}

/** `{recipe, source, target?}` → the detail sheet's view, or null if unusable. */
export function normalizeRecipeDetail(payload: unknown): RecipeDetail | null {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const recipe = recipeRow(raw.recipe);
  if (!recipe) return null;
  const source = (raw.source ?? {}) as Record<string, unknown>;
  const target = (raw.target ?? {}) as Record<string, unknown>;
  return {
    recipe,
    sourceName: str(source.name),
    sourceStatus: str(source.runtime_status),
    targetName: str(target.name),
    targetStatus: str(target.runtime_status),
  };
}

export function recipeSearchTerm(search: string): string {
  return search.slice(0, RECIPE_MAX_SEARCH_CHARS).trim().toLocaleLowerCase();
}

export interface RecipeFilters {
  search: string;
  /** "available" | "planned" | "" for both. */
  availability: string;
}

/**
 * Search mirrors the server's `recipeMatches` (handlers.go:697) FIELD FOR
 * FIELD: id, name, provider, source and target slugs, summary, badge, the
 * blueprint's trigger / destination / surface / required scopes / required
 * secrets / events / data handling, every field mapping's source, target and
 * description, every capability, and every step's title, description, action,
 * path and required fields.
 *
 * The whole list, and not a readable-looking subset, because a subset is the
 * quiet kind of wrong: the server would have returned the Shopify recipe for
 * "SHOPIFY_WEBHOOK_SECRET" (a required secret) or "orders/create" (a step
 * path), and a phone that dropped those fields answers "no recipes match" for
 * a query the product does match. Nothing here is a secret VALUE — the
 * blueprint's secret and scope entries are names, and `blueprintLines` already
 * renders them on the row.
 */
export function filterRecipes(
  rows: readonly RecipeRow[],
  filters: RecipeFilters,
): RecipeRow[] {
  const query = recipeSearchTerm(filters.search);
  const { availability } = filters;
  return rows.filter((row) => {
    if (availability === "available" && !row.available) return false;
    if (availability === "planned" && row.available) return false;
    if (!query) return true;
    const haystack = [
      row.id,
      row.name,
      row.provider,
      row.sourceSlug,
      row.targetSlug,
      row.summary,
      row.badge,
      row.blueprint.trigger,
      row.blueprint.destination,
      row.blueprint.postwaveSurface,
      ...row.capabilities,
      ...row.blueprint.events,
      ...row.blueprint.requiredScopes,
      ...row.blueprint.requiredSecrets,
      ...row.blueprint.dataHandling,
      ...row.steps.map(
        (step) =>
          `${step.title} ${step.description} ${step.action} ${step.path} ${step.requiredFields.join(" ")}`,
      ),
      ...row.blueprint.fieldMappings.map(
        (mapping) =>
          `${mapping.source} ${mapping.target} ${mapping.description}`,
      ),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return haystack.includes(query);
  });
}

/**
 * The availability line, from the SERVER's summary counts.
 *
 * Null when the server did not send them: counting the rows in hand would
 * state a catalog-wide fact from whatever page arrived.
 */
export function recipeAvailabilityLine(list: RecipeList): string | null {
  const total = list.summary.total;
  const available = list.summary.available;
  if (typeof total !== "number" || typeof available !== "number") return null;
  return `${available} of ${total} recipes are marked available. The rest are planned wiring, listed so coverage can be read honestly.`;
}

export function recipeResultSentence(
  total: number,
  matched: number,
  filtered: boolean,
): string {
  if (!filtered) return `${total} recipes.`;
  return `${matched} of ${total} recipes match the active filters.`;
}

export interface BlueprintLine {
  label: string;
  value: string;
}

/**
 * The blueprint as label/value lines, omitting every field the server left
 * empty. An empty section rendered as "Required scopes: —" would suggest the
 * recipe needs none, which is a different claim from "not stated".
 *
 * `sample_payload` is deliberately not rendered: it is an untyped
 * `map[string]any` on the wire and a phone is the wrong place to display an
 * arbitrary nested object that may echo provider field names.
 */
export function blueprintLines(recipe: RecipeRow): BlueprintLine[] {
  const bp = recipe.blueprint;
  const out: BlueprintLine[] = [];
  const push = (label: string, value: string) => {
    if (value) out.push({ label, value });
  };
  push("Trigger", bp.trigger);
  push("Destination", bp.destination);
  push("Moosewave surface", bp.postwaveSurface);
  push("Events", bp.events.join(", "));
  push("Required scopes", bp.requiredScopes.join(", "));
  push("Required secrets", bp.requiredSecrets.join(", "));
  push("Data handling", bp.dataHandling.join(" "));
  if (bp.fieldMappings.length > 0) {
    push(
      "Field mappings",
      bp.fieldMappings
        .map(
          (mapping) =>
            `${transitionLabel(mapping.source, mapping.target)}${mapping.required ? " (required)" : ""}`,
        )
        .join("; "),
    );
  }
  return out;
}

/**
 * What the phone says about running this recipe.
 *
 * The apply route answers `delegated` for every recipe without writing
 * anything, so there is one honest sentence and it does not depend on the
 * recipe: the wiring is configured on the surface that owns it.
 */
export function recipeApplyNotice(recipe: RecipeRow): string {
  if (!recipe.available) {
    return "This recipe is not available yet. It is listed so the coverage reports can count it, not because it can be run.";
  }
  return "Applying a recipe is desk work: the server's apply endpoint only hands back this blueprint and points at the surface that owns the wiring, which needs the provider's credentials to finish.";
}
