import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { toast } from "../../components/Toast";
import {
  integrationsApi,
  type IntegrationCatalogItem,
  type IntegrationConnection,
  type IntegrationRecipe,
  type IntegrationsCatalogResponse,
  type IntegrationsCoverageResponse,
  type IntegrationsReadinessResponse,
  type IntegrationsStackReport,
} from "../../lib/api-client";
import {
  ALL_FILTER,
  filterIntegrationItems,
  filterIntegrationRecipes,
  integrationApiErrorDetail,
  refineIntegrationItems,
  summarizeIntegrations,
  type IntegrationCatalogSort,
  type IntegrationConnectionFilter,
} from "../integrations-helpers";
import {
  parseIntegrationsCatalog,
  parseIntegrationsReadiness,
  parseIntegrationsConnections,
  parseIntegrationsCoverage,
  parseIntegrationsRecipes,
  parseIntegrationsStacks,
} from "../integrations-response-contract";

export type IntegrationsViewId = "catalog" | "recipes" | "coverage" | "stacks";
export type RecipeAvailability = "all" | "ready" | "planned";

export type IntegrationsResourceName =
  | "connections"
  | "coverage"
  | "stacks"
  | "readiness"
  | "recipes";

export interface IntegrationsResourceIssue {
  resource: IntegrationsResourceName;
  message: string;
}

type IntegrationStats = ReturnType<typeof summarizeIntegrations>;

export interface IntegrationsCatalogController {
  catalog: IntegrationsCatalogResponse | null;
  connections: IntegrationConnection[];
  coverage: IntegrationsCoverageResponse | null;
  stacks: IntegrationsStackReport | null;
  readiness: IntegrationsReadinessResponse | null;
  recipes: IntegrationRecipe[];
  recipeSummary: Record<string, number>;
  loading: boolean;
  error: string;
  resourceIssues: IntegrationsResourceIssue[];
  lastUpdatedAt: number | null;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  category: string;
  setCategory: Dispatch<SetStateAction<string>>;
  badge: string;
  setBadge: Dispatch<SetStateAction<string>>;
  view: IntegrationsViewId;
  setView: Dispatch<SetStateAction<IntegrationsViewId>>;
  recipeAvailability: RecipeAvailability;
  setRecipeAvailability: Dispatch<SetStateAction<RecipeAvailability>>;
  connectionFilter: IntegrationConnectionFilter;
  setConnectionFilter: Dispatch<SetStateAction<IntegrationConnectionFilter>>;
  sort: IntegrationCatalogSort;
  setSort: Dispatch<SetStateAction<IntegrationCatalogSort>>;
  clearFilters: () => void;
  refresh: () => Promise<void>;
  connectionMap: Map<string, IntegrationConnection>;
  categoryLabels: Map<string, string>;
  filtered: IntegrationCatalogItem[];
  filteredRecipes: IntegrationRecipe[];
  stats: IntegrationStats;
}

export function useIntegrationsCatalogController(): IntegrationsCatalogController {
  const [catalog, setCatalog] = useState<IntegrationsCatalogResponse | null>(
    null,
  );
  const [connections, setConnections] = useState<IntegrationConnection[]>([]);
  const [coverage, setCoverage] = useState<IntegrationsCoverageResponse | null>(
    null,
  );
  const [stacks, setStacks] = useState<IntegrationsStackReport | null>(null);
  const [readiness, setReadiness] =
    useState<IntegrationsReadinessResponse | null>(null);
  const [recipes, setRecipes] = useState<IntegrationRecipe[]>([]);
  const [recipeSummary, setRecipeSummary] = useState<Record<string, number>>(
    {},
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [resourceIssues, setResourceIssues] = useState<
    IntegrationsResourceIssue[]
  >([]);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(ALL_FILTER);
  const [badge, setBadge] = useState(ALL_FILTER);
  const [view, setView] = useState<IntegrationsViewId>("catalog");
  const [recipeAvailability, setRecipeAvailability] =
    useState<RecipeAvailability>("all");
  const [connectionFilter, setConnectionFilter] =
    useState<IntegrationConnectionFilter>("all");
  const [sort, setSort] = useState<IntegrationCatalogSort>("recommended");
  const refreshSequence = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshSequence.current += 1;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const sequence = refreshSequence.current + 1;
    refreshSequence.current = sequence;
    setLoading(true);
    setError("");
    setResourceIssues([]);
    let results: [
      Awaited<ReturnType<typeof integrationsApi.catalog>>,
      Awaited<ReturnType<typeof integrationsApi.connections>>,
      Awaited<ReturnType<typeof integrationsApi.coverage>>,
      Awaited<ReturnType<typeof integrationsApi.stacks>>,
      Awaited<ReturnType<typeof integrationsApi.readiness>>,
      Awaited<ReturnType<typeof integrationsApi.recipes>>,
    ];
    try {
      results = await Promise.all([
        integrationsApi.catalog(),
        integrationsApi.connections(),
        integrationsApi.coverage(),
        integrationsApi.stacks(),
        integrationsApi.readiness(),
        integrationsApi.recipes(),
      ]);
    } catch {
      if (!mounted.current || refreshSequence.current !== sequence) return;
      setError(
        "Moosewave could not verify the integrations catalog. Check the connection and retry.",
      );
      setLoading(false);
      return;
    }
    if (!mounted.current || refreshSequence.current !== sequence) return;
    const [
      catalogRes,
      connectionsRes,
      coverageRes,
      stacksRes,
      readinessRes,
      recipesRes,
    ] = results;
    const parsedCatalog = catalogRes.error
      ? null
      : parseIntegrationsCatalog(catalogRes.data);
    if (catalogRes.error || !parsedCatalog) {
      setError(
        (catalogRes.error
          ? integrationApiErrorDetail(catalogRes.error)
          : null) ?? "The integrations catalog returned a malformed response.",
      );
      setLoading(false);
      return;
    }
    setCatalog(parsedCatalog);
    const issues: IntegrationsResourceIssue[] = [];
    if (connectionsRes.error) {
      issues.push({
        resource: "connections",
        message: integrationApiErrorDetail(connectionsRes.error),
      });
    } else {
      const parsedConnections = parseIntegrationsConnections(
        connectionsRes.data,
      );
      if (parsedConnections) setConnections(parsedConnections.items);
      else
        issues.push({
          resource: "connections",
          message: "The connection inventory returned a malformed response.",
        });
    }
    if (coverageRes.error) {
      issues.push({
        resource: "coverage",
        message: integrationApiErrorDetail(coverageRes.error),
      });
    } else {
      const parsedCoverage = parseIntegrationsCoverage(coverageRes.data);
      if (parsedCoverage) setCoverage(parsedCoverage);
      else
        issues.push({
          resource: "coverage",
          message: "The coverage service returned a malformed response.",
        });
    }
    if (stacksRes.error) {
      issues.push({
        resource: "stacks",
        message: integrationApiErrorDetail(stacksRes.error),
      });
    } else {
      const parsedStacks = parseIntegrationsStacks(stacksRes.data);
      if (parsedStacks) setStacks(parsedStacks);
      else
        issues.push({
          resource: "stacks",
          message: "The stack service returned a malformed response.",
        });
    }
    if (readinessRes.error) {
      issues.push({
        resource: "readiness",
        message: integrationApiErrorDetail(readinessRes.error),
      });
    } else {
      const parsedReadiness = parseIntegrationsReadiness(readinessRes.data);
      if (parsedReadiness) setReadiness(parsedReadiness);
      else
        issues.push({
          resource: "readiness",
          message: "The readiness service returned a malformed response.",
        });
    }
    if (recipesRes.error) {
      issues.push({
        resource: "recipes",
        message: integrationApiErrorDetail(recipesRes.error),
      });
    } else {
      const parsedRecipes = parseIntegrationsRecipes(recipesRes.data);
      if (parsedRecipes) {
        setRecipes(parsedRecipes.items);
        setRecipeSummary(parsedRecipes.summary);
      } else {
        issues.push({
          resource: "recipes",
          message: "The recipe service returned a malformed response.",
        });
      }
    }
    setResourceIssues(issues);
    if (issues.length > 0) {
      toast.info({
        message: `Catalog verified with ${issues.length} unavailable ${issues.length === 1 ? "resource" : "resources"}`,
        detail: issues.map((issue) => issue.resource).join(", "),
      });
    }
    setLastUpdatedAt(Date.now());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connectionMap = useMemo(
    () =>
      new Map(connections.map((connection) => [connection.slug, connection])),
    [connections],
  );
  const categoryLabels = useMemo(
    () =>
      new Map((catalog?.categories ?? []).map((row) => [row.key, row.label])),
    [catalog?.categories],
  );
  const filtered = useMemo(() => {
    const matches = filterIntegrationItems(
      catalog?.items ?? [],
      query,
      category,
      badge,
    );
    return refineIntegrationItems(
      matches,
      connectionMap,
      connectionFilter,
      sort,
    );
  }, [
    badge,
    catalog?.items,
    category,
    connectionFilter,
    connectionMap,
    query,
    sort,
  ]);
  const filteredRecipes = useMemo(
    () => filterIntegrationRecipes(recipes, query, badge, recipeAvailability),
    [badge, query, recipeAvailability, recipes],
  );
  const stats = useMemo(
    () => summarizeIntegrations(catalog?.items ?? [], connections),
    [catalog?.items, connections],
  );

  return {
    catalog,
    connections,
    coverage,
    stacks,
    readiness,
    recipes,
    recipeSummary,
    loading,
    error,
    resourceIssues,
    lastUpdatedAt,
    query,
    setQuery,
    category,
    setCategory,
    badge,
    setBadge,
    view,
    setView,
    recipeAvailability,
    setRecipeAvailability,
    connectionFilter,
    setConnectionFilter,
    sort,
    setSort,
    clearFilters: () => {
      setQuery("");
      setCategory(ALL_FILTER);
      setBadge(ALL_FILTER);
      setRecipeAvailability("all");
      setConnectionFilter("all");
      setSort("recommended");
    },
    refresh,
    connectionMap,
    categoryLabels,
    filtered,
    filteredRecipes,
    stats,
  };
}
