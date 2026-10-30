import { describe, expect, it } from "vitest";

import type {
  IntegrationCatalogItem,
  IntegrationsStackReport,
} from "../lib/api-client";
import {
  badgeLabel,
  countAvailableRecipes,
  filterIntegrationItems,
  filterIntegrationRecipes,
  filterIntegrationStacks,
  firstActionableSetupStep,
  integrationHasSource,
  integrationApiErrorDetail,
  lifecycleActionButtonClass,
  lifecycleActionLabel,
  lifecycleActionNeedsConnection,
  nativeConnectTarget,
  nativeProviderFamily,
  summarizeIntegrations,
} from "../pages/integrations-helpers";

const items: IntegrationCatalogItem[] = [
  {
    slug: "shopify",
    name: "Shopify",
    category: "ecommerce",
    badge: "native",
    runtime_status: "delegated",
    summary: "Sync orders and products.",
    capabilities: ["orders", "products"],
    native: true,
    sources: ["commerce"],
  },
  {
    slug: "snowflake",
    name: "Snowflake",
    category: "warehouse",
    badge: "planned",
    runtime_status: "planned",
    summary: "Planned warehouse connector.",
    capabilities: ["warehouse_export"],
    native: false,
    sources: ["warehouse"],
  },
  {
    slug: "typeform",
    name: "Typeform",
    category: "forms",
    badge: "zapier",
    runtime_status: "delegated",
    summary: "Bridge form submissions.",
    capabilities: ["profiles", "events"],
    native: false,
    sources: ["bridge"],
  },
  {
    slug: "facebook-lead-ads",
    name: "Facebook Lead Ads",
    category: "ads",
    badge: "native",
    runtime_status: "partial",
    summary: "Managed lead form sync.",
    capabilities: ["profiles", "events"],
    native: true,
    sources: ["lead_capture"],
  },
];

const recipeBlueprint = {
  trigger: "form submission",
  destination: "Moosewave",
  postwave_surface: "/webhooks",
  field_mappings: [
    {
      source: "email",
      target: "profile.email",
      required: true,
      description: "Primary subscriber identity",
    },
  ],
};

describe("integrations helpers", () => {
  it("preserves bounded operator evidence for API failures", () => {
    expect(
      integrationApiErrorDetail({
        message: "Provider timed out",
        code: "provider_timeout",
        requestId: "req_123",
        retryAfterSeconds: 12.4,
      }),
    ).toBe(
      "Provider timed out · Code provider_timeout · Request req_123 · Retry after 12s",
    );
  });

  it("filters across names, slugs, summaries, and capabilities", () => {
    expect(filterIntegrationItems(items, "shopify", "all", "all")).toHaveLength(
      1,
    );
    expect(
      filterIntegrationItems(items, "warehouse", "all", "all")[0]?.slug,
    ).toBe("snowflake");
    expect(
      filterIntegrationItems(items, "events", "forms", "all")[0]?.slug,
    ).toBe("typeform");
    expect(filterIntegrationItems(items, "", "all", "planned")[0]?.slug).toBe(
      "snowflake",
    );
  });

  it("summarizes catalog and connection state", () => {
    expect(
      summarizeIntegrations(items, [
        {
          slug: "shopify",
          name: "Shopify",
          category: "ecommerce",
          badge: "native",
          runtime_status: "delegated",
          connected: true,
          status: "active",
          count: 1,
        },
      ]),
    ).toEqual({
      total: 4,
      native: 2,
      connected: 1,
      delegated: 2,
      planned: 1,
    });
  });

  it("renders honest badge labels", () => {
    expect(badgeLabel("api_sdk")).toBe("API/SDK");
    expect(badgeLabel("migration_only")).toBe("Migration-only");
  });

  it("detects native provider families from catalog sources", () => {
    const leadAds = items.find((item) => item.slug === "facebook-lead-ads");
    expect(leadAds).toBeTruthy();
    expect(
      leadAds ? integrationHasSource(leadAds, "lead_capture") : false,
    ).toBe(true);
    expect(leadAds ? nativeProviderFamily(leadAds) : null).toBe("lead_capture");
    expect(nativeProviderFamily(items[0])).toBeNull();
  });

  it("routes only native connect actions to their managed setup surface", () => {
    // Commerce catalog cards hand off to the canonical Commerce owner instead
    // of opening a second credential modal inside Integrations.
    expect(nativeConnectTarget(items[0], "connect")).toBeNull();
    expect(nativeConnectTarget(items[0], "sync")).toBeNull();
    expect(
      nativeConnectTarget(
        {
          ...items[0],
          slug: "hubspot",
          name: "HubSpot",
          category: "crm",
          sources: ["crm"],
        },
        "connect",
      ),
    ).toBe("crm");
    expect(
      nativeConnectTarget(
        {
          ...items[0],
          slug: "snowflake",
          name: "Snowflake",
          category: "warehouse",
          sources: ["warehouse"],
        },
        "connect",
      ),
    ).toBe("warehouse");
    expect(nativeConnectTarget(items[2], "connect")).toBeNull();
  });

  it("counts available recipes and finds setup actions", () => {
    expect(
      countAvailableRecipes([
        {
          id: "a",
          name: "A",
          provider: "Zapier",
          source_slug: "typeform",
          summary: "Ready",
          badge: "zapier",
          available: true,
          estimated_minutes: 10,
          capabilities: [],
          steps: [],
          blueprint: recipeBlueprint,
        },
        {
          id: "b",
          name: "B",
          provider: "Planned",
          source_slug: "snowflake",
          summary: "Later",
          badge: "planned",
          available: false,
          estimated_minutes: 0,
          capabilities: [],
          steps: [],
          blueprint: recipeBlueprint,
        },
      ]),
    ).toBe(1);
    expect(
      firstActionableSetupStep([
        { title: "Read", description: "No action" },
        {
          title: "Open",
          description: "Has action",
          action: "Open",
          path: "/webhooks",
        },
      ])?.title,
    ).toBe("Open");
  });

  it("describes lifecycle action controls", () => {
    expect(lifecycleActionLabel("connect/start")).toBe("Connect");
    expect(lifecycleActionLabel("connect/callback")).toBe("Complete OAuth");
    expect(lifecycleActionLabel("backfill")).toBe("Backfill");
    expect(lifecycleActionButtonClass("disconnect")).toBe("btn btn-danger");
    expect(lifecycleActionButtonClass("sync")).toBe("btn btn-primary");
    expect(lifecycleActionNeedsConnection("sync")).toBe(true);
    expect(lifecycleActionNeedsConnection("connect/start")).toBe(false);
  });

  it("filters recipes by query, badge, and availability", () => {
    const recipes = [
      {
        id: "typeform-leads",
        name: "Typeform leads",
        provider: "Zapier",
        source_slug: "typeform",
        target_slug: "inbound-webhooks",
        summary: "Capture submissions",
        badge: "zapier" as const,
        available: true,
        estimated_minutes: 12,
        capabilities: ["profiles"],
        steps: [{ title: "Map fields", description: "Map email" }],
        blueprint: recipeBlueprint,
      },
      {
        id: "snowflake-export",
        name: "Snowflake export",
        provider: "Planned",
        source_slug: "snowflake",
        summary: "Warehouse export",
        badge: "planned" as const,
        available: false,
        estimated_minutes: 0,
        capabilities: ["warehouse_export"],
        steps: [],
        blueprint: {
          ...recipeBlueprint,
          trigger: "scheduled export",
          destination: "Snowflake",
        },
      },
    ];
    expect(
      filterIntegrationRecipes(recipes, "email", "all", "ready"),
    ).toHaveLength(1);
    expect(
      filterIntegrationRecipes(recipes, "", "planned", "planned")[0]?.id,
    ).toBe("snowflake-export");
    expect(
      filterIntegrationRecipes(recipes, "profile.email", "all", "all")[0]?.id,
    ).toBe("typeform-leads");
  });

  it("keeps impact-gap evidence consistent with active stack filters", () => {
    const component = {
      slug: "shopify",
      name: "Shopify",
      role: "commerce",
      required: true,
      category: "ecommerce",
      badge: "native" as const,
      runtime_status: "verified",
      available: true,
      native_managed: true,
      bridge_available: false,
      reason: "Native order sync",
    };
    const report: IntegrationsStackReport = {
      schema_version: "1",
      target_coverage_pct: 90,
      covered_pct: 50,
      covered_stacks: 1,
      total_stacks: 2,
      summary: {},
      stacks: [
        {
          key: "commerce",
          name: "Commerce stack",
          segment: "retail",
          summary: "Orders and customers",
          status: "ready",
          coverage_pct: 100,
          required_covered: 1,
          required_total: 1,
          optional_covered: 0,
          optional_total: 0,
          native_managed: 1,
          bridge_ready: 0,
          components: [component],
          next_actions: ["Monitor order sync"],
        },
        {
          key: "forms",
          name: "Forms stack",
          segment: "growth",
          summary: "Lead capture",
          status: "partial",
          coverage_pct: 50,
          required_covered: 0,
          required_total: 1,
          optional_covered: 0,
          optional_total: 0,
          native_managed: 0,
          bridge_ready: 1,
          components: [
            {
              ...component,
              slug: "typeform",
              name: "Typeform",
              role: "lead_capture",
              category: "forms",
              badge: "zapier",
              native_managed: false,
              bridge_available: true,
            },
          ],
          next_actions: ["Configure webhook"],
        },
      ],
      highest_impact_gaps: [
        {
          slug: "snowflake",
          name: "Snowflake",
          stacks: 2,
          required_count: 1,
          reason: "Warehouse export is missing",
        },
      ],
      newsletter_commerce_ok: true,
    };

    expect(
      filterIntegrationStacks(report, "customers", "all", "all").stacks,
    ).toHaveLength(1);
    expect(
      filterIntegrationStacks(report, "", "forms", "zapier").stacks[0]?.key,
    ).toBe("forms");
    expect(
      filterIntegrationStacks(report, "snowflake", "forms", "zapier")
        .highest_impact_gaps,
    ).toHaveLength(0);
    expect(
      filterIntegrationStacks(report, "snowflake", "all", "all")
        .highest_impact_gaps,
    ).toHaveLength(1);
  });
});
