import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, within } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * The three read-only browse panels on the integrations tab: the CATALOG
 * (what could be connected), the RECIPES (how a provider reaches a Moosewave
 * surface) and the ECOSYSTEM reports (coverage / readiness / stacks).
 *
 * All three exist to answer a question the rest of the tab cannot, and all
 * three are one bad render away from telling a lie the register specifically
 * warns about:
 *
 *   - The catalog is ~614 entries and only ~32 report `runtime_status:
 *     "available"` (apps/api/internal/integrations/catalog.go — 21 of those 32
 *     are migration-only importers and ~370 of the rest are generated Zapier
 *     bridges at `delegated`). A row that showed a name and a tier without the
 *     runtime status would read as a menu of 614 connectable tools.
 *   - The ecosystem reports are release GATES. A count the server did not send
 *     must render as an em-dash: "0 blockers" and "unknown" are opposite
 *     verdicts.
 *   - `POST /integrations/recipes/{id}/apply` writes nothing (handlers.go:297
 *     hard-codes `delegated` and returns 202), so no apply control may exist.
 *
 * These tests pin those three, plus the admin gate the manifest states for all
 * six routes, plus the paging that keeps 614 rows off a phone's render pass.
 */

jest.mock("@/hooks/useIntegrationsCatalog", () => ({
  useIntegrationsCatalog: jest.fn(),
}));
jest.mock("@/hooks/useIntegrationRecipes", () => ({
  useIntegrationRecipes: jest.fn(),
  useIntegrationRecipeDetail: jest.fn(),
}));
jest.mock("@/hooks/useIntegrationsEcosystem", () => ({
  useIntegrationsCoverage: jest.fn(),
  useIntegrationsReadiness: jest.fn(),
  useIntegrationsStacks: jest.fn(),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const catalogHooks = require("@/hooks/useIntegrationsCatalog");
const recipeHooks = require("@/hooks/useIntegrationRecipes");
const ecosystemHooks = require("@/hooks/useIntegrationsEcosystem");
const gateMock = require("@/hooks/useOnlineQueryGate");

// eslint-disable-next-line import/first
import { IntegrationRecipesPanel } from "@/components/integrations/IntegrationRecipesPanel";
// eslint-disable-next-line import/first
import { IntegrationsCatalogPanel } from "@/components/integrations/IntegrationsCatalogPanel";
// eslint-disable-next-line import/first
import { IntegrationsEcosystemPanel } from "@/components/integrations/IntegrationsEcosystemPanel";
// eslint-disable-next-line import/first
import type { CatalogEntry, IntegrationsCatalog } from "@/lib/integrationsCatalog";
// eslint-disable-next-line import/first
import type { RecipeList, RecipeRow } from "@/lib/integrationRecipes";
// eslint-disable-next-line import/first
import type { CoverageView, ReadinessView } from "@/lib/integrationsEcosystem";

/** The real useQuery result shape, so every branch a panel reads exists. */
function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(),
    ...over,
  };
}

const idleQuery = () => queryResult({});

function entry(over: Partial<CatalogEntry>): CatalogEntry {
  return {
    slug: "x",
    name: "X",
    category: "productivity",
    badge: "zapier",
    runtimeStatus: "delegated",
    summary: "",
    capabilities: [],
    sources: [],
    setupPath: "",
    phase: "",
    native: false,
    ...over,
  };
}

/** Three real shapes from catalog.go, then filler to force the page break. */
const CATALOG: IntegrationsCatalog = {
  entries: [
    entry({
      slug: "csv",
      name: "CSV import",
      category: "migrations",
      badge: "native",
      runtimeStatus: "available",
      summary: "Import subscribers, attributes, and opt-in state from CSV.",
      capabilities: ["profiles", "lists"],
      sources: ["migration"],
      native: true,
    }),
    entry({
      slug: "zendesk",
      name: "Zendesk",
      category: "customer_service",
      badge: "planned",
      runtimeStatus: "planned",
      summary:
        "Release-held support-provider catalog entry. Provider setup, pulls, callbacks, sync, backfill, and lifecycle effects are unavailable until Helpdesk tenant authority, immutable evidence, and privacy governance are certified together.",
      sources: ["support_integration"],
    }),
    entry({
      slug: "airtable",
      name: "Airtable",
      category: "productivity",
      badge: "zapier",
      runtimeStatus: "delegated",
      summary: "Reach Airtable through the Zapier bridge.",
      sources: ["zapier_bridge"],
    }),
    ...Array.from({ length: 27 }, (_unused, i) =>
      entry({ slug: `filler-${i}`, name: `Filler ${i}` }),
    ),
  ],
  categories: [
    { key: "migrations", label: "Migrations" },
    { key: "customer_service", label: "Customer service" },
    { key: "productivity", label: "Productivity" },
  ],
  badges: ["native", "partner", "zapier", "webhook", "api_sdk", "migration_only", "planned"],
  // The server's own counts, from countCatalog (handlers.go:3120).
  counts: { total: 614, "runtime:available": 32 },
};

function recipe(over: Partial<RecipeRow>): RecipeRow {
  return {
    id: "r",
    name: "R",
    provider: "",
    sourceSlug: "",
    targetSlug: "",
    summary: "",
    badge: "native",
    available: true,
    estimatedMinutes: null,
    setupPath: "",
    capabilities: [],
    steps: [],
    blueprint: {
      trigger: "",
      destination: "",
      postwaveSurface: "",
      requiredScopes: [],
      requiredSecrets: [],
      events: [],
      dataHandling: [],
      fieldMappings: [],
    },
    ...over,
  };
}

const RECIPES: RecipeList = {
  items: [
    recipe({
      id: "shopify-orders",
      name: "Shopify orders to commerce events",
      provider: "Shopify",
      sourceSlug: "shopify",
      summary: "Stream orders into Moosewave commerce events.",
      available: true,
      blueprint: {
        trigger: "orders/create webhook",
        destination: "Moosewave commerce events",
        postwaveSurface: "Commerce",
        requiredScopes: ["read_orders"],
        requiredSecrets: [],
        events: ["order.created"],
        dataHandling: [],
        fieldMappings: [],
      },
    }),
    recipe({
      id: "acme-bridge",
      name: "Acme bridge",
      badge: "zapier",
      available: false,
      summary: "Planned bridge wiring.",
    }),
  ],
  summary: { total: 310, available: 190 },
};

const READINESS: ReadinessView = {
  ready: false,
  marketable: false,
  publicClaim:
    "Integration parity is in progress; use readiness checks before making public parity claims.",
  checks: [
    {
      key: "public_entries",
      label: "Public catalog entries",
      state: "pass",
      severity: "ok",
      count: 614,
      message: "614 public catalog entries against a target of 350.",
    },
    {
      key: "native_verified",
      label: "Native verification",
      state: "fail",
      severity: "blocker",
      count: 7,
      message: "7 native-verified connectors against a target of 70.",
    },
  ],
  issues: [],
  // No `severity:blocker` key: the verdict must NOT invent a blocker count.
  issueCounts: {},
  recommendations: ["Promote the highest-impact priority gaps."],
};

const COVERAGE: CoverageView = {
  targets: [
    {
      label: "Public catalog entries",
      value: 614,
      target: 350,
      parity: true,
    },
    // The server sent no native-verified value: this must read as unreported.
    {
      label: "Native-verified connectors",
      value: null,
      target: null,
      parity: null,
    },
  ],
  bridgeReady: 370,
  planned: null,
  availableRecipes: 190,
  categories: [],
  priorityGaps: [],
};

function wrap(node: React.ReactElement) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {node}
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  catalogHooks.useIntegrationsCatalog.mockImplementation(idleQuery);
  recipeHooks.useIntegrationRecipes.mockImplementation(idleQuery);
  recipeHooks.useIntegrationRecipeDetail.mockImplementation(idleQuery);
  ecosystemHooks.useIntegrationsCoverage.mockImplementation(idleQuery);
  ecosystemHooks.useIntegrationsReadiness.mockImplementation(idleQuery);
  ecosystemHooks.useIntegrationsStacks.mockImplementation(idleQuery);
});

afterEach(() => {
  gateMock.__resetOnlineGateForTests();
});

describe("the admin gate the manifest states is stated, not discovered", () => {
  it("tells a viewer the catalog needs admin instead of rendering an empty one", async () => {
    gateMock.__setOnlineGateForTests({ effectiveRole: "viewer" });
    const screen = await wrap(<IntegrationsCatalogPanel />);
    expect(
      screen.getByText(/Browsing the catalog needs an owner or admin session/),
    ).toBeTruthy();
    // And offers no affordance that could only ever collect a 403.
    expect(screen.queryByLabelText("Browse the integration catalog")).toBeNull();
  });

  it("tells a viewer the ecosystem reports and recipes need admin too", async () => {
    gateMock.__setOnlineGateForTests({ effectiveRole: "viewer" });
    const reports = await wrap(<IntegrationsEcosystemPanel />);
    expect(
      reports.getByText(
        /Coverage, readiness and stack reports need an owner or admin session/,
      ),
    ).toBeTruthy();
    const recipes = await wrap(<IntegrationRecipesPanel />);
    expect(
      recipes.getByText(/Recipes need an owner or admin session/),
    ).toBeTruthy();
  });
});

describe("the catalog never implies 614 connectable entries", () => {
  async function openCatalog() {
    catalogHooks.useIntegrationsCatalog.mockImplementation(() =>
      queryResult({ data: CATALOG }),
    );
    const screen = await wrap(<IntegrationsCatalogPanel />);
    await fireEvent.press(
      screen.getByLabelText("Browse the integration catalog"),
    );
    return screen;
  }

  it("leads with the server's own availability count", async () => {
    const screen = await openCatalog();
    expect(
      screen.getByText(
        /32 of 614 catalog entries report runtime status "available"/,
      ),
    ).toBeTruthy();
  });

  it("gives every row BOTH axes: the tier and the runtime status", async () => {
    const screen = await openCatalog();
    // Scoped to each row, because the tier and status pills are rendered
    // independently of the accessibility label: asserting only the label would
    // let a row show "Available" beside a delegated entry and still pass.
    const csv = within(
      screen.getByLabelText(
        "CSV import. Migrations. Tier Native, status Available.",
      ),
    );
    expect(csv.getByText("CSV import")).toBeTruthy();
    expect(csv.getByText("Native")).toBeTruthy();
    expect(csv.getByText("Available")).toBeTruthy();

    const airtable = within(
      screen.getByLabelText(
        "Airtable. Productivity. Tier Zapier, status Delegated.",
      ),
    );
    expect(airtable.getByText("Airtable")).toBeTruthy();
    expect(airtable.getByText("Zapier")).toBeTruthy();
    expect(airtable.getByText("Delegated")).toBeTruthy();
    expect(airtable.queryByText("Available")).toBeNull();
  });

  it("says in words that a non-available entry is not connectable", async () => {
    const screen = await openCatalog();
    await fireEvent.press(
      screen.getByLabelText(
        "Airtable. Productivity. Tier Zapier, status Delegated.",
      ),
    );
    expect(screen.getByText(/Not connectable today/)).toBeTruthy();
    expect(screen.queryByText(/Connect it from the web admin/)).toBeNull();
  });

  it("offers the web hand-off only on an entry that is actually available", async () => {
    const screen = await openCatalog();
    await fireEvent.press(
      screen.getByLabelText(
        "CSV import. Migrations. Tier Native, status Available.",
      ),
    );
    expect(screen.getByText(/Connect it from the web admin/)).toBeTruthy();
  });

  it("renders one page, not the whole catalog, and says how many are left", async () => {
    const screen = await openCatalog();
    expect(screen.getByText("Filler 21")).toBeTruthy();
    // 30 entries, CATALOG_PAGE_SIZE is 25 → the last five are behind the fold.
    expect(screen.queryByText("Filler 26")).toBeNull();
    await fireEvent.press(
      screen.getByLabelText(
        "Show more catalog entries, 5 more entries available",
      ),
    );
    expect(screen.getByText("Filler 26")).toBeTruthy();
  });

  it("narrows on the server's own vocabulary and counts the narrowing", async () => {
    const screen = await openCatalog();
    expect(screen.getByText("30 catalog entries.")).toBeTruthy();
    await fireEvent.changeText(
      screen.getByLabelText("Search the integration catalog"),
      "support_integration",
    );
    // The source token only the Zendesk row carries — the same field the
    // server's catalogItemMatches joins.
    expect(
      screen.getByText("1 of 30 entries match the active filters."),
    ).toBeTruthy();
    expect(screen.getByText("Zendesk")).toBeTruthy();
    expect(screen.queryByText("Airtable")).toBeNull();
  });

  it("renders a failed read as a failure, never as an empty catalog", async () => {
    catalogHooks.useIntegrationsCatalog.mockImplementation(() =>
      queryResult({ isError: true, error: new Error("500") }),
    );
    const screen = await wrap(<IntegrationsCatalogPanel />);
    await fireEvent.press(
      screen.getByLabelText("Browse the integration catalog"),
    );
    expect(screen.queryByText(/The catalog came back empty/)).toBeNull();
    expect(screen.queryByText(/no entries/)).toBeNull();
  });
});

describe("the ecosystem reports render the server's verdict, not ours", () => {
  it("quotes the public claim as the claim the gate PERMITS", async () => {
    ecosystemHooks.useIntegrationsReadiness.mockImplementation(() =>
      queryResult({ data: READINESS }),
    );
    const screen = await wrap(<IntegrationsEcosystemPanel />);
    await fireEvent.press(screen.getByLabelText("Open the ecosystem reports"));
    await fireEvent.press(screen.getByLabelText("Readiness"));
    expect(
      screen.getByText(
        /Claim the gate currently permits: “Integration parity is in progress/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Failing")).toBeTruthy();
    // No `severity:blocker` count arrived, so no blocker clause is invented.
    expect(screen.getByText("Release gate does not pass.")).toBeTruthy();
    expect(screen.queryByText(/0 blockers/)).toBeNull();
  });

  it("renders an unreported coverage number as an em-dash, never as zero", async () => {
    ecosystemHooks.useIntegrationsCoverage.mockImplementation(() =>
      queryResult({ data: COVERAGE }),
    );
    const screen = await wrap(<IntegrationsEcosystemPanel />);
    await fireEvent.press(screen.getByLabelText("Open the ecosystem reports"));
    expect(screen.getByText("614 of 350")).toBeTruthy();
    expect(screen.getByText("— (not reported)")).toBeTruthy();
    // `planned` is null in the fixture: it must not print as 0.
    expect(screen.getByText(/Planned —/)).toBeTruthy();
  });
});

describe("recipes are readable and offer no apply", () => {
  async function openRecipes() {
    recipeHooks.useIntegrationRecipes.mockImplementation(() =>
      queryResult({ data: RECIPES }),
    );
    const screen = await wrap(<IntegrationRecipesPanel />);
    await fireEvent.press(screen.getByLabelText("Open the integration recipes"));
    return screen;
  }

  it("marks each recipe with the server's availability, not just a name", async () => {
    const screen = await openRecipes();
    expect(screen.getByText("Shopify orders to commerce events")).toBeTruthy();
    // "Available"/"Planned" also label the availability filter chips, so the
    // per-row claim is read off each row's accessibility label instead.
    expect(
      screen.getByLabelText(
        "Shopify orders to commerce events. Native. Available.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Acme bridge. Zapier. Planned.")).toBeTruthy();
    // …and off the VISIBLE pill inside each row. An accessibility label and a
    // pill are built from `available` independently, so asserting only the
    // label lets a sighted reader be shown "Available" on planned wiring while
    // the test still passes.
    const planned = within(
      screen.getByLabelText("Acme bridge. Zapier. Planned."),
    );
    expect(planned.getByText("Planned")).toBeTruthy();
    expect(planned.queryByText("Available")).toBeNull();
    const live = within(
      screen.getByLabelText(
        "Shopify orders to commerce events. Native. Available.",
      ),
    );
    expect(live.getByText("Available")).toBeTruthy();
    expect(live.queryByText("Planned")).toBeNull();
    expect(
      screen.getByText(/190 of 310 recipes are marked available/),
    ).toBeTruthy();
  });

  it("expands to the blueprint and never offers an apply control", async () => {
    const screen = await openRecipes();
    await fireEvent.press(
      screen.getByLabelText(
        "Shopify orders to commerce events. Native. Available.",
      ),
    );
    expect(screen.getByText("Trigger: orders/create webhook")).toBeTruthy();
    expect(screen.getByText("Required scopes: read_orders")).toBeTruthy();
    expect(screen.getByText(/Applying a recipe is desk work/)).toBeTruthy();
    // The apply route writes nothing, so nothing may look like it does.
    // `\b` keeps the explanatory sentence ("Applying a recipe is desk work…")
    // out of the match while still catching a control called "Apply recipe".
    expect(screen.queryByLabelText(/\bApply\b/i)).toBeNull();
    expect(screen.queryByText(/\bApply\b/)).toBeNull();
  });

  it("says a planned recipe cannot be run at all", async () => {
    const screen = await openRecipes();
    await fireEvent.press(
      screen.getByLabelText("Acme bridge. Zapier. Planned."),
    );
    expect(
      screen.getByText(/This recipe is not available yet/),
    ).toBeTruthy();
  });
});
