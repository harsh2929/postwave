// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  normalizeIntegrationsCatalog,
  type IntegrationsCatalog,
} from "@/lib/integrations-catalog-api";

describe("normalizeIntegrationsCatalog", () => {
  it("maps nullable collection fields from catalog-only providers to arrays", () => {
    const catalog = normalizeIntegrationsCatalog({
      schema_version: "1",
      target_public_entries: 1,
      target_native_managed: 0,
      honest_badges: null as never,
      categories: null as never,
      capabilities: null as never,
      counts: null as never,
      items: [
        {
          slug: "mcp",
          name: "MCP",
          category: "developer_tools",
          badge: "api_sdk",
          runtime_status: "delegated",
          summary: "Model Context Protocol surface",
          capabilities: null as never,
          sources: null as never,
          native: false,
        },
      ],
    } satisfies IntegrationsCatalog);

    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]?.capabilities).toEqual([]);
    expect(catalog.items[0]?.sources).toEqual([]);
    expect(catalog.capabilities).toEqual([]);
    expect(catalog.categories).toEqual([]);
    expect(catalog.honest_badges).toEqual([]);
    expect(catalog.counts).toEqual({});
  });
});
