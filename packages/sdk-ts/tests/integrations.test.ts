import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";
import { integrationPathSegment } from "../src/resources/integrations.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("IntegrationsResource", () => {
  it("serializes catalog and recipe filters", async () => {
    const seen: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      seen.push(url);
      return json({ items: [], counts: {}, summary: {} });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    await pw.integrations.catalog({
      q: "Shopify",
      category: "ecommerce",
      badge: "native",
      capability: "orders",
    });
    await pw.integrations.recipes({
      source: "hubspot",
      provider: "zapier",
      available: true,
    });

    expect(seen[0]).toContain("/api/v1/integrations/catalog?");
    expect(seen[0]).toContain("q=Shopify");
    expect(seen[0]).toContain("category=ecommerce");
    expect(seen[0]).toContain("badge=native");
    expect(seen[0]).toContain("capability=orders");
    expect(seen[1]).toContain("/api/v1/integrations/recipes?");
    expect(seen[1]).toContain("source=hubspot");
    expect(seen[1]).toContain("provider=zapier");
    expect(seen[1]).toContain("available=true");
  });

  it("encodes slugs and recipe IDs in facade paths", async () => {
    const seen: Array<{ url: string; method?: string }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method });
      return json({
        slug: "hubspot/crm",
        action: "sync",
        status: "delegated",
        message: "ok",
      });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    await pw.integrations.detail("hubspot/crm");
    await pw.integrations.health("hubspot/crm");
    await pw.integrations.contract("hubspot/crm");
    await pw.integrations.recipe("recipe/a");
    await pw.integrations.applyRecipe("recipe/a");

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/integrations/hubspot%2Fcrm",
        method: "GET",
      },
      {
        url: "https://api.moosewave.com/api/v1/integrations/hubspot%2Fcrm/health",
        method: "GET",
      },
      {
        url: "https://api.moosewave.com/api/v1/integrations/hubspot%2Fcrm/contract",
        method: "GET",
      },
      {
        url: "https://api.moosewave.com/api/v1/integrations/recipes/recipe%2Fa",
        method: "GET",
      },
      {
        url: "https://api.moosewave.com/api/v1/integrations/recipes/recipe%2Fa/apply",
        method: "POST",
      },
    ]);
  });

  it("requests coverage, stacks, and readiness reports", async () => {
    const seen: Array<{ url: string; method?: string }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method });
      return json({
        schema_version: "test",
        checks: [],
        issues: [],
        issue_counts: {},
        recommendations: [],
      });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    await pw.integrations.coverage();
    await pw.integrations.stacks();
    await pw.integrations.readiness();

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/integrations/coverage",
        method: "GET",
      },
      {
        url: "https://api.moosewave.com/api/v1/integrations/stacks",
        method: "GET",
      },
      {
        url: "https://api.moosewave.com/api/v1/integrations/readiness",
        method: "GET",
      },
    ]);
  });

  it("maps lifecycle helpers to the canonical facade endpoints", async () => {
    const seen: Array<{ url: string; method?: string }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method });
      return json({
        slug: "snowflake",
        action: "sync",
        status: "delegated",
        message: "ok",
        primary_connection_id: "warehouse_1",
      });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    await pw.integrations.startConnect("snowflake");
    await pw.integrations.finishConnect("snowflake");
    await pw.integrations.sync("snowflake");
    await pw.integrations.backfill("snowflake");
    await pw.integrations.pause("snowflake");
    await pw.integrations.disconnect("snowflake");

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/integrations/snowflake/connect/start",
        method: "POST",
      },
      {
        url: "https://api.moosewave.com/api/v1/integrations/snowflake/connect/callback",
        method: "POST",
      },
      {
        url: "https://api.moosewave.com/api/v1/integrations/snowflake/sync",
        method: "POST",
      },
      {
        url: "https://api.moosewave.com/api/v1/integrations/snowflake/backfill",
        method: "POST",
      },
      {
        url: "https://api.moosewave.com/api/v1/integrations/snowflake/pause",
        method: "POST",
      },
      {
        url: "https://api.moosewave.com/api/v1/integrations/snowflake",
        method: "DELETE",
      },
    ]);
  });

  it("guards empty path identifiers before fetch", async () => {
    const fetch = vi.fn(async () => json({}));
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    expect(integrationPathSegment("hubspot/crm")).toBe("hubspot%2Fcrm");
    expect(() => integrationPathSegment(" ")).toThrow(/integration slug is required/);
    expect(() => pw.integrations.detail(" ")).toThrow(/integration slug is required/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
