// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Transport contract for the generic integrations facade + native family
// lifecycle routes: every function sends the exact method, path and body the
// server mounts (apps/api/internal/integrations/handlers.go MountRoutes,
// lead_integrations/handlers.go, crm_integrations/handlers.go …), and a body
// that is not the evidence that was asked for is refused, not rendered.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONN,
  actionBody,
  catalogItem,
  connectionRow,
  contract,
  detailBody,
  healthReport,
  installFetchRouter,
  recipe,
} from "../helpers/integrations-lifecycle-harness";
import {
  EMPTY_POSTURE_FILTER,
  IntegrationEvidenceError,
  connectionIds,
  connectionIsAmbiguous,
  filterCatalogByPosture,
  integrationsLifecycleApi,
  isSupportRuntimeHeld,
  leadIntegrationName,
  leadIntegrationsApi,
  nativeLifecycleClients,
  nativeLifecycleFamily,
  parseConnectionsReport,
  type CustomerStack,
  type IntegrationConnection,
} from "@/lib/integrations-lifecycle-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generic facade reads", () => {
  it("GETs detail, health and contract at the slug routes and verifies the slug", async () => {
    const router = installFetchRouter({
      "GET /api/v1/integrations/hubspot": { body: detailBody() },
      "GET /api/v1/integrations/hubspot/health": {
        body: healthReport({ state: "needs_attention" }),
      },
      "GET /api/v1/integrations/hubspot/contract": { body: contract() },
    });

    const detail = await integrationsLifecycleApi.detail("hubspot");
    expect(detail.item.slug).toBe("hubspot");
    expect(detail.lifecycle_actions).toContain("backfill");
    expect(detail.connection.primary_connection_id).toBe(CONN);
    const health = await integrationsLifecycleApi.health("hubspot");
    expect(health.state).toBe("needs_attention");
    const read = await integrationsLifecycleApi.contract("hubspot");
    expect(read.public_claim).toMatch(/Native CRM foundation/);

    expect(
      router.requests.map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "GET /api/v1/integrations/hubspot",
      "GET /api/v1/integrations/hubspot/health",
      "GET /api/v1/integrations/hubspot/contract",
    ]);
  });

  it("refuses a detail or contract that belongs to another integration", async () => {
    installFetchRouter({
      "GET /api/v1/integrations/hubspot": {
        body: detailBody({ item: catalogItem({ slug: "salesforce" }) }),
      },
      "GET /api/v1/integrations/hubspot/contract": {
        body: contract({ slug: "salesforce" }),
      },
    });
    await expect(integrationsLifecycleApi.detail("hubspot")).rejects.toThrow(
      IntegrationEvidenceError,
    );
    await expect(integrationsLifecycleApi.contract("hubspot")).rejects.toThrow(
      IntegrationEvidenceError,
    );
  });

  it("GETs the catalog-wide posture reports and forwards filter queries", async () => {
    const router = installFetchRouter({
      "GET /api/v1/integrations/connections": {
        body: { items: [connectionRow()], summary: { total: 1 }, returned: 1 },
      },
      "GET /api/v1/integrations/coverage": {
        body: { public_entries: 614, target_public_entries: 350 },
      },
      "GET /api/v1/integrations/stacks": { body: { stacks: [] } },
      "GET /api/v1/integrations/readiness": {
        body: { ready: false, checks: [], issues: [] },
      },
      "GET /api/v1/integrations/recipes": {
        body: { items: [recipe()], summary: { total: 1, available: 1 } },
      },
    });

    await integrationsLifecycleApi.connections({
      footprint: true,
      health: "needs_attention",
    });
    const coverage = await integrationsLifecycleApi.coverage();
    await integrationsLifecycleApi.stacks();
    const readiness = await integrationsLifecycleApi.readiness();
    const recipes = await integrationsLifecycleApi.recipes({
      source: "hubspot",
      available: true,
    });

    expect(coverage.public_entries).toBe(614);
    expect(readiness.ready).toBe(false);
    expect(recipes.items[0]?.id).toBe("hubspot-contacts-to-list");
    const [connections, , , , recipesRequest] = router.requests;
    expect(connections?.path).toBe("/api/v1/integrations/connections");
    expect(new URLSearchParams(connections?.search).get("footprint")).toBe(
      "true",
    );
    expect(new URLSearchParams(connections?.search).get("health")).toBe(
      "needs_attention",
    );
    expect(recipesRequest?.path).toBe("/api/v1/integrations/recipes");
    expect(new URLSearchParams(recipesRequest?.search).get("source")).toBe(
      "hubspot",
    );
    expect(new URLSearchParams(recipesRequest?.search).get("available")).toBe(
      "true",
    );
  });

  it("treats an envelope without items as a failed read, never as zero connections", () => {
    expect(() => parseConnectionsReport({ summary: {} })).toThrow(
      IntegrationEvidenceError,
    );
  });
});

describe("generic facade lifecycle writes", () => {
  it.each([
    ["connectStart", "POST", "/api/v1/integrations/zapier/connect/start", "connect/start"],
    ["sync", "POST", "/api/v1/integrations/zapier/sync", "sync"],
    ["backfill", "POST", "/api/v1/integrations/zapier/backfill", "backfill"],
    ["pause", "POST", "/api/v1/integrations/zapier/pause", "pause"],
    ["disconnect", "DELETE", "/api/v1/integrations/zapier", "disconnect"],
  ] as const)(
    "%s sends %s %s and returns the server's delegation",
    async (fn, method, path, action) => {
      const router = installFetchRouter({
        [`${method} ${path}`]: {
          status: 202,
          body: actionBody("zapier", action),
        },
      });
      const response = await integrationsLifecycleApi[fn]("zapier");
      expect(response.status).toBe("delegated");
      expect(response.action).toBe(action);
      expect(router.writes()).toEqual([
        {
          method,
          path,
          search: "",
          body: method === "POST" ? {} : undefined,
        },
      ]);
    },
  );

  it("refuses a lifecycle response for a different action", async () => {
    installFetchRouter({
      "POST /api/v1/integrations/zapier/backfill": {
        status: 202,
        body: actionBody("zapier", "sync"),
      },
    });
    await expect(integrationsLifecycleApi.backfill("zapier")).rejects.toThrow(
      IntegrationEvidenceError,
    );
  });

  it("surfaces the 409 sentence for a planned integration", async () => {
    installFetchRouter({
      "POST /api/v1/integrations/iterable/sync": {
        status: 409,
        body: actionBody("iterable", "sync", {
          status: "unavailable",
          message:
            "Iterable is a later roadmap preview and exposes no connection lifecycle.",
        }),
      },
    });
    await expect(integrationsLifecycleApi.sync("iterable")).rejects.toThrow(
      /roadmap preview and exposes no connection lifecycle/,
    );
  });

  it("GETs a recipe and POSTs its preparation, verifying the recipe id", async () => {
    const router = installFetchRouter({
      "GET /api/v1/integrations/recipes/hubspot-contacts-to-list": {
        body: { recipe: recipe(), source: catalogItem() },
      },
      "POST /api/v1/integrations/recipes/hubspot-contacts-to-list/apply": {
        status: 202,
        body: {
          recipe_id: "hubspot-contacts-to-list",
          status: "delegated",
          message: "Open the owning Moosewave surface.",
          delegated_to: "POST /api/v1/crm/integrations",
          required_fields: ["credentials_ref"],
          next_steps: [{ title: "Connect HubSpot", description: "" }],
          blueprint: {},
        },
      },
    });
    const reviewed = await integrationsLifecycleApi.recipeDetail(
      "hubspot-contacts-to-list",
    );
    expect(reviewed.source?.slug).toBe("hubspot");
    const plan = await integrationsLifecycleApi.applyRecipe(
      "hubspot-contacts-to-list",
    );
    expect(plan.delegated_to).toBe("POST /api/v1/crm/integrations");
    expect(router.writes()).toEqual([
      {
        method: "POST",
        path: "/api/v1/integrations/recipes/hubspot-contacts-to-list/apply",
        search: "",
        body: {},
      },
    ]);
  });
});

describe("native family lifecycle routes", () => {
  it.each([
    ["crm", "/api/v1/crm/integrations"],
    ["lead_capture", "/api/v1/lead-integrations"],
    ["review_integration", "/api/v1/review-integrations"],
    ["loyalty_integration", "/api/v1/loyalty-integrations"],
    ["subscription_integration", "/api/v1/subscription-integrations"],
    ["analytics_integration", "/api/v1/analytics-integrations"],
  ] as const)("%s backfills, syncs, pauses and disconnects at %s/{id}", async (family, base) => {
    const router = installFetchRouter({
      [`POST ${base}/${CONN}/backfill`]: { body: { status: "queued" } },
      [`POST ${base}/${CONN}/sync`]: { body: { status: "queued" } },
      [`POST ${base}/${CONN}/pause`]: { body: { status: "paused" } },
      [`DELETE ${base}/${CONN}`]: { body: { status: "disconnected" } },
    });
    const client = nativeLifecycleClients[family];
    await client.backfill(CONN);
    await client.sync(CONN);
    await client.pause(CONN);
    await client.disconnect(CONN);
    expect(
      router.writes().map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      `POST ${base}/${CONN}/backfill`,
      `POST ${base}/${CONN}/sync`,
      `POST ${base}/${CONN}/pause`,
      `DELETE ${base}/${CONN}`,
    ]);
  });

  it("maps a catalog row to its family the way desktop does", () => {
    expect(nativeLifecycleFamily({ badge: "native", sources: ["crm"] })).toBe(
      "crm",
    );
    expect(
      nativeLifecycleFamily({ badge: "native", sources: ["lead_capture"] }),
    ).toBe("lead_capture");
    expect(
      nativeLifecycleFamily({ badge: "partner", sources: ["crm"] }),
    ).toBeNull();
    expect(
      isSupportRuntimeHeld({ category: "customer_service", sources: [] }),
    ).toBe(true);
  });

  it("counts every distinct id when judging whether the target is exact", () => {
    const one = parseConnectionsReport({
      items: [connectionRow()],
    }).items[0] as IntegrationConnection;
    expect(connectionIds(one)).toEqual([CONN]);
    expect(connectionIsAmbiguous(one)).toBe(false);
    expect(connectionIsAmbiguous({ ...one, count: 2 })).toBe(true);
  });
});

describe("lead capture", () => {
  it("GETs providers and POSTs a credential-reference configuration", async () => {
    const router = installFetchRouter({
      "GET /api/v1/lead-integrations/providers": {
        body: {
          items: [
            {
              provider: "typeform",
              name: "Typeform",
              managed: true,
              required_settings: [
                { key: "form_id", label: "Form ID", required: true },
                {
                  key: "credentials_ref",
                  label: "Credential reference",
                  required: true,
                },
              ],
            },
          ],
        },
      },
      "POST /api/v1/lead-integrations": {
        status: 201,
        body: { id: CONN, provider: "typeform", name: "Typeform abc", status: "active" },
      },
    });
    const providers = await leadIntegrationsApi.providers();
    expect(providers[0]?.required_settings.map((field) => field.key)).toEqual([
      "form_id",
      "credentials_ref",
    ]);
    const saved = await leadIntegrationsApi.create({
      provider: "typeform",
      name: leadIntegrationName({ name: "Typeform" }, { form_id: "abc" }),
      credentials_ref: "vault://lead/typeform",
      settings: { form_id: "abc" },
    });
    expect(saved.id).toBe(CONN);
    expect(router.writes()).toEqual([
      {
        method: "POST",
        path: "/api/v1/lead-integrations",
        search: "",
        body: {
          provider: "typeform",
          name: "Typeform abc",
          credentials_ref: "vault://lead/typeform",
          settings: { form_id: "abc" },
        },
      },
    ]);
  });
});

describe("filterCatalogByPosture", () => {
  const items = [
    catalogItem(),
    catalogItem({ slug: "salesforce", name: "Salesforce" }),
    catalogItem({ slug: "iterable", name: "Iterable", runtime_status: "planned", category: "marketing" }),
  ];
  const connections = new Map<string, IntegrationConnection>(
    parseConnectionsReport({
      items: [
        connectionRow(),
        connectionRow({
          slug: "salesforce",
          health_state: "needs_attention",
          last_error: "token expired",
        }),
      ],
    }).items.map((row) => [row.slug, row]),
  );
  const stacks: CustomerStack[] = [
    {
      key: "b2b",
      name: "B2B SaaS",
      segment: "",
      summary: "",
      status: "partial",
      coverage_pct: 50,
      required_covered: 1,
      required_total: 2,
      components: [
        {
          slug: "salesforce",
          name: "Salesforce",
          role: "crm",
          required: true,
          category: "crm",
          badge: "native",
          available: true,
          reason: "",
        },
      ],
      next_actions: [],
    },
  ];

  it("narrows by workspace state, stack, category and search", () => {
    const slugs = (filter: Partial<typeof EMPTY_POSTURE_FILTER>) =>
      filterCatalogByPosture(
        items,
        { ...EMPTY_POSTURE_FILTER, ...filter },
        connections,
        stacks,
      ).map((item) => item.slug);
    expect(slugs({})).toEqual(["hubspot", "salesforce", "iterable"]);
    expect(slugs({ state: "attention" })).toEqual(["salesforce"]);
    expect(slugs({ state: "planned" })).toEqual(["iterable"]);
    expect(slugs({ stack: "b2b" })).toEqual(["salesforce"]);
    expect(slugs({ category: "marketing" })).toEqual(["iterable"]);
    expect(slugs({ query: "hub" })).toEqual(["hubspot"]);
  });
});
