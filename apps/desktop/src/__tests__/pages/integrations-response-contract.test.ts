import { describe, expect, it } from "vitest";

import {
  parseIntegrationActionResponse,
  parseIntegrationDetail,
  parseIntegrationRecipeApplyResponse,
  parseIntegrationRecipeDetail,
  parseIntegrationRecipePrepareResponse,
  parseIntegrationsConnections,
  parseIntegrationsCoverage,
  parseIntegrationsRecipes,
  parseIntegrationsStacks,
} from "../../pages/integrations-response-contract";

function catalogItem(slug = "shop") {
  return {
    slug,
    name: slug === "shop" ? "Shop" : "Moosewave",
    category: "ecommerce",
    badge: "native",
    runtime_status: "available",
    summary: "A verified test connector.",
    capabilities: ["profiles"],
    native: true,
    sources: ["commerce"],
  };
}

function connection(slug = "shop") {
  return {
    slug,
    name: slug === "shop" ? "Shop" : "Moosewave",
    category: "ecommerce",
    badge: "native",
    runtime_status: "available",
    connected: true,
    status: "active",
    count: 1,
    primary_connection_id: `${slug}-connection-1`,
    connection_ids: [`${slug}-connection-1`],
    last_sync_at: "2026-08-09T10:00:00Z",
    health_state: "healthy",
    health_message: "The connector is healthy.",
  };
}

const blueprint = {
  trigger: "shop event",
  destination: "Moosewave",
  postwave_surface: "/integrations",
  required_scopes: ["profiles.read"],
  field_mappings: [
    {
      source: "email",
      target: "profile.email",
      required: true,
    },
  ],
  sample_payload: { email: "customer@example.com", active: true },
};

function recipe(id = "shop-profile-sync") {
  return {
    id,
    name: "Sync shop profiles",
    provider: "Native",
    source_slug: "shop",
    summary: "Sync profiles into Moosewave.",
    badge: "native",
    available: true,
    estimated_minutes: 10,
    capabilities: ["profiles"],
    steps: [
      {
        title: "Connect the shop",
        description: "Open the managed connector setup.",
        action: "Connect",
        path: "/integrations",
        required_fields: ["credentials_ref"],
      },
    ],
    blueprint,
  };
}

const health = {
  state: "healthy",
  severity: "ok",
  message: "The connector is healthy.",
  monitoring_surface: "Commerce",
  checks: [
    {
      key: "ownership",
      label: "Ownership",
      state: "ok",
      message: "Moosewave owns this connector.",
    },
  ],
  retry_policy: {
    mode: "provider_pull",
    max_attempts: 3,
    backoff: "exponential",
    dead_letter: "integration error state",
    idempotency: "provider object id",
  },
  sync_history: [
    {
      at: "2026-08-09T10:00:00Z",
      action: "commerce_sync",
      status: "completed",
      attempts: 1,
      message: "The latest run completed.",
    },
  ],
  audit_trail: [
    {
      at: "2026-08-09T10:00:00Z",
      action: "integration.connection.observed",
      actor: "system",
      message: "A connection was observed.",
    },
  ],
  data_delete: [
    {
      method: "DELETE",
      path: "/api/v1/commerce/integrations/{id}",
      description: "Disconnect the integration.",
    },
  ],
};

const connectorContract = {
  slug: "shop",
  owner: "postwave",
  badge: "native",
  runtime_status: "available",
  native_managed: true,
  native_verified: true,
  implementation_depth: "native_verified",
  public_claim: "A native managed connector.",
  auth_modes: ["oauth"],
  credential_storage: "encrypted vault",
  secret_policy: "references only",
  setup_surface: "Commerce",
  monitoring: ["sync history"],
  lifecycle_actions: ["connect/start", "sync", "disconnect"],
  required_scopes: ["profiles.read"],
  data_objects: ["profiles"],
  event_topics: ["profile.updated"],
  compliance_gates: ["consent"],
  privacy_actions: ["disconnect"],
  rate_limit_policy: "provider aware",
  partner_review: "not applicable",
};

const detail = {
  item: catalogItem(),
  connection: connection(),
  setup: [
    {
      title: "Connect",
      description: "Create the managed connection.",
    },
  ],
  recipes: [recipe()],
  lifecycle_actions: ["connect/start", "sync", "disconnect"],
  health,
  contract: connectorContract,
};

describe("integrations connections response contract", () => {
  it("accepts the required returned count and additive optional fields", () => {
    const response = {
      items: [connection()],
      summary: { total: 1, connected: 1 },
      returned: 1,
      future_optional: { version: 2 },
    };

    expect(parseIntegrationsConnections(response)).toEqual(response);
  });

  it("rejects missing, inconsistent, duplicate, and oversized inventory data", () => {
    expect(
      parseIntegrationsConnections({
        items: [connection()],
        summary: { total: 1 },
      }),
    ).toBeNull();
    expect(
      parseIntegrationsConnections({
        items: [connection()],
        summary: { total: 1 },
        returned: 0,
      }),
    ).toBeNull();
    expect(
      parseIntegrationsConnections({
        items: [connection(), connection()],
        summary: { total: 2 },
        returned: 2,
      }),
    ).toBeNull();
    expect(
      parseIntegrationsConnections({
        items: [
          {
            ...connection(),
            primary_connection_id: "not-in-the-list",
          },
        ],
        summary: { total: 1 },
        returned: 1,
      }),
    ).toBeNull();
    expect(
      parseIntegrationsConnections({
        items: Array.from({ length: 2_001 }, (_, index) =>
          connection(`shop-${index}`),
        ),
        summary: { total: 1_001 },
        returned: 2_001,
      }),
    ).toBeNull();
    expect(
      parseIntegrationsConnections({
        items: [],
        summary: Object.fromEntries(
          Array.from({ length: 513 }, (_, index) => [`count:${index}`, 0]),
        ),
        returned: 0,
      }),
    ).toBeNull();
  });
});

const coverage = {
  schema_version: "2026-06.integrations.coverage.v1",
  target_public_entries: 350,
  target_native_managed: 70,
  target_native_verified: 70,
  public_entries: 350,
  native_managed: 70,
  native_verified: 60,
  native_partial: 10,
  native_delegated: 0,
  public_gap: 0,
  native_gap: 0,
  native_verification_gap: 10,
  public_parity: true,
  native_parity: true,
  native_verification_parity: false,
  bridge_ready: 100,
  planned: 5,
  available_recipes: 120,
  generated_recipes: 20,
  badge_counts: { native: 70 },
  phase_counts: { expansion: 10 },
  maturity_counts: { verified_hybrid_ready: 1 },
  categories: [
    {
      key: "ecommerce",
      label: "Ecommerce",
      total: 20,
      native_managed: 10,
      native_verified: 8,
      native_partial: 2,
      native_delegated: 0,
      bridge_ready: 12,
      planned: 1,
      available_recipes: 14,
      maturity: "verified_hybrid_ready",
    },
  ],
  priority_gaps: [
    {
      slug: "legacy-shop",
      name: "Legacy Shop",
      category: "ecommerce",
      current_badge: "partner",
      runtime_status: "delegated",
      bridge_available: true,
      reason: "Native verification remains.",
    },
  ],
};

describe("integrations coverage response contract", () => {
  it("accepts a bounded coverage report", () => {
    expect(parseIntegrationsCoverage(coverage)).toEqual(coverage);
  });

  it("rejects unsupported statuses and duplicate or oversized identities", () => {
    expect(
      parseIntegrationsCoverage({
        ...coverage,
        categories: [
          { ...coverage.categories[0], maturity: "future_maturity" },
        ],
      }),
    ).toBeNull();
    expect(
      parseIntegrationsCoverage({
        ...coverage,
        categories: [...coverage.categories, coverage.categories[0]],
      }),
    ).toBeNull();
    expect(
      parseIntegrationsCoverage({
        ...coverage,
        priority_gaps: [...coverage.priority_gaps, coverage.priority_gaps[0]],
      }),
    ).toBeNull();
    expect(
      parseIntegrationsCoverage({
        ...coverage,
        priority_gaps: Array.from({ length: 2_001 }, (_, index) => ({
          ...coverage.priority_gaps[0],
          slug: `gap-${index}`,
        })),
      }),
    ).toBeNull();
  });
});

const stacks = {
  schema_version: "2026-06.integrations.stacks.v1",
  target_coverage_pct: 90,
  covered_pct: 100,
  covered_stacks: 1,
  total_stacks: 1,
  summary: { "status:ready": 1 },
  stacks: [
    {
      key: "newsletter-commerce",
      name: "Newsletter commerce",
      segment: "commerce",
      summary: "A complete commerce stack.",
      status: "ready",
      coverage_pct: 100,
      required_covered: 1,
      required_total: 1,
      optional_covered: 0,
      optional_total: 0,
      native_managed: 1,
      bridge_ready: 0,
      components: [
        {
          slug: "shop",
          name: "Shop",
          role: "commerce source",
          required: true,
          category: "ecommerce",
          badge: "native",
          runtime_status: "available",
          available: true,
          native_managed: true,
          bridge_available: false,
          reason: "A verified native connector is available.",
        },
      ],
      next_actions: ["Connect the shop."],
    },
  ],
  highest_impact_gaps: [
    {
      slug: "legacy-shop",
      name: "Legacy Shop",
      stacks: 1,
      required_count: 1,
      reason: "A native connector is missing.",
    },
  ],
  newsletter_commerce_ok: true,
};

describe("integrations stack response contract", () => {
  it("accepts a bounded stack report", () => {
    expect(parseIntegrationsStacks(stacks)).toEqual(stacks);
  });

  it("rejects unsupported statuses, duplicate slugs, and oversized nesting", () => {
    expect(
      parseIntegrationsStacks({
        ...stacks,
        stacks: [{ ...stacks.stacks[0], status: "unknown" }],
      }),
    ).toBeNull();
    expect(
      parseIntegrationsStacks({
        ...stacks,
        stacks: [
          {
            ...stacks.stacks[0],
            components: [
              ...stacks.stacks[0].components,
              stacks.stacks[0].components[0],
            ],
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseIntegrationsStacks({
        ...stacks,
        stacks: [
          {
            ...stacks.stacks[0],
            next_actions: Array.from(
              { length: 257 },
              (_, index) => `Action ${index}`,
            ),
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("integrations recipe response contracts", () => {
  it("accepts recipe lists and rejects duplicate ids or oversized payloads", () => {
    const response = { items: [recipe()], summary: { total: 1 } };
    expect(parseIntegrationsRecipes(response)).toEqual(response);
    expect(
      parseIntegrationsRecipes({
        ...response,
        items: [recipe(), recipe()],
      }),
    ).toBeNull();
    expect(
      parseIntegrationsRecipes({
        ...response,
        items: [
          {
            ...recipe(),
            summary: "x".repeat(16_385),
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseIntegrationsRecipes({
        ...response,
        items: [
          {
            ...recipe(),
            blueprint: {
              ...blueprint,
              sample_payload: {
                values: Array.from({ length: 257 }, () => "value"),
              },
            },
          },
        ],
      }),
    ).toBeNull();
  });

  it("checks recipe detail source, target, and requested identity", () => {
    const recipeWithTarget = {
      ...recipe(),
      target_slug: "postwave",
    };
    const response = {
      recipe: recipeWithTarget,
      source: catalogItem(),
      target: catalogItem("postwave"),
    };
    expect(parseIntegrationRecipeDetail(response, "shop-profile-sync")).toEqual(
      response,
    );
    expect(
      parseIntegrationRecipeDetail(
        { recipe: recipeWithTarget, source: catalogItem() },
        "shop-profile-sync",
      ),
    ).not.toBeNull();
    expect(parseIntegrationRecipeDetail(response, "wrong-id")).toBeNull();
    expect(
      parseIntegrationRecipeDetail({
        ...response,
        source: catalogItem("postwave"),
      }),
    ).toBeNull();
    expect(
      parseIntegrationRecipeDetail({
        ...response,
        target: catalogItem("wrong-target"),
      }),
    ).toBeNull();
  });
});

describe("integration detail response contract", () => {
  it("accepts a consistent detail response for the requested slug", () => {
    expect(parseIntegrationDetail(detail, "shop")).toEqual(detail);
  });

  it("rejects wrong-target and internally inconsistent detail bodies", () => {
    expect(parseIntegrationDetail(detail, "wrong-shop")).toBeNull();
    expect(
      parseIntegrationDetail({
        ...detail,
        connection: connection("postwave"),
      }),
    ).toBeNull();
    expect(
      parseIntegrationDetail({
        ...detail,
        contract: { ...connectorContract, slug: "postwave" },
      }),
    ).toBeNull();
    expect(
      parseIntegrationDetail({
        ...detail,
        lifecycle_actions: ["connect/start", "launch-unknown"],
      }),
    ).toBeNull();
    expect(
      parseIntegrationDetail({
        ...detail,
        recipes: [recipe(), recipe()],
      }),
    ).toBeNull();
  });
});

describe("integration aggregate action response contract", () => {
  const actionResponse = {
    slug: "shop",
    action: "sync",
    status: "unavailable",
    message: "The planned connector cannot sync yet.",
    primary_connection_id: "shop-connection-1",
    connection_ids: ["shop-connection-1"],
    future_receipt: "optional-future-field",
  };

  it("accepts unavailable without accepting arbitrary statuses", () => {
    expect(
      parseIntegrationActionResponse(actionResponse, {
        slug: "shop",
        action: "sync",
      }),
    ).toEqual(actionResponse);
    expect(
      parseIntegrationActionResponse({
        ...actionResponse,
        status: "accepted",
      }),
    ).toBeNull();
    expect(
      parseIntegrationActionResponse({
        ...actionResponse,
        action: "launch-unknown",
      }),
    ).toBeNull();
  });

  it("rejects wrong requested identity and connection-id inconsistency", () => {
    expect(
      parseIntegrationActionResponse(actionResponse, { slug: "wrong-shop" }),
    ).toBeNull();
    expect(
      parseIntegrationActionResponse(actionResponse, { action: "backfill" }),
    ).toBeNull();
    expect(
      parseIntegrationActionResponse({
        ...actionResponse,
        primary_connection_id: "missing",
      }),
    ).toBeNull();
    expect(
      parseIntegrationActionResponse({
        ...actionResponse,
        required_fields: Array.from(
          { length: 65 },
          (_, index) => `field-${index}`,
        ),
      }),
    ).toBeNull();
  });
});

describe("integration recipe prepare/apply response contract", () => {
  const applyResponse = {
    recipe_id: "shop-profile-sync",
    status: "delegated",
    message: "Open the owning surface with this blueprint.",
    delegated_to: "POST /api/v1/commerce/integrations",
    required_fields: ["credentials_ref"],
    next_steps: [
      {
        title: "Connect",
        description: "Create the managed connection.",
      },
    ],
    blueprint,
  };

  it("accepts both semantic parser exports", () => {
    expect(
      parseIntegrationRecipeApplyResponse(applyResponse, "shop-profile-sync"),
    ).toEqual(applyResponse);
    expect(
      parseIntegrationRecipePrepareResponse(applyResponse, "shop-profile-sync"),
    ).toEqual(applyResponse);
  });

  it("rejects wrong ids, unsupported status, and malformed blueprints", () => {
    expect(
      parseIntegrationRecipeApplyResponse(applyResponse, "wrong-recipe"),
    ).toBeNull();
    expect(
      parseIntegrationRecipeApplyResponse({
        ...applyResponse,
        status: "unavailable",
      }),
    ).toBeNull();
    expect(
      parseIntegrationRecipeApplyResponse({
        ...applyResponse,
        blueprint: { ...blueprint, trigger: undefined },
      }),
    ).toBeNull();
  });
});
