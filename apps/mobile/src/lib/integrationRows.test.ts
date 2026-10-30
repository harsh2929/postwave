import { describe, expect, it } from "vitest";

import {
  countByStatus,
  healthStateToStatus,
  manageUrl,
  normalizeIntegrationRows,
  titleCaseSlug,
} from "./integrationRows";

const connected = {
  slug: "slack",
  name: "Slack",
  connected: true,
  health_state: "healthy",
};

describe("normalizeIntegrationRows — envelope shapes", () => {
  it("reads { items: [...] }", () => {
    expect(normalizeIntegrationRows({ items: [connected] })).toHaveLength(1);
  });

  it("reads { integrations: [...] }", () => {
    expect(
      normalizeIntegrationRows({ integrations: [connected] }),
    ).toHaveLength(1);
  });

  it("reads a bare array", () => {
    expect(normalizeIntegrationRows([connected])).toHaveLength(1);
  });

  it("returns [] for null / a string / an object with neither key", () => {
    expect(normalizeIntegrationRows(null)).toEqual([]);
    expect(normalizeIntegrationRows("nope")).toEqual([]);
    expect(normalizeIntegrationRows({ summary: { total: 3 } })).toEqual([]);
  });

  it("returns [] rather than throwing when items is not an array", () => {
    expect(normalizeIntegrationRows({ items: { a: 1 } })).toEqual([]);
  });
});

describe("normalizeIntegrationRows — tenant-footprint filter", () => {
  it("drops catalog rows with no connection, no count and no error", () => {
    const rows = normalizeIntegrationRows({
      items: [
        { slug: "planned-thing", connected: false, count: 0 },
        connected,
      ],
    });
    expect(rows.map((r) => r.slug)).toEqual(["slack"]);
  });

  it("keeps a disconnected row that still has a count", () => {
    const rows = normalizeIntegrationRows({
      items: [{ slug: "shopify", connected: false, count: 3 }],
    });
    expect(rows).toHaveLength(1);
  });

  it("keeps a disconnected row that carries an error", () => {
    const rows = normalizeIntegrationRows({
      items: [
        { slug: "hubspot", connected: false, count: 0, last_error: "401" },
      ],
    });
    expect(rows[0]?.last_error).toBe("401");
  });

  it("treats a whitespace-only error as no error", () => {
    expect(
      normalizeIntegrationRows({
        items: [{ slug: "x", connected: false, count: 0, last_error: "   " }],
      }),
    ).toEqual([]);
  });
});

describe("healthStateToStatus", () => {
  it("maps healthy", () => {
    expect(healthStateToStatus("healthy")).toBe("healthy");
    expect(healthStateToStatus("HEALTHY")).toBe("healthy");
  });

  it("maps action_required to failing", () => {
    expect(healthStateToStatus("action_required")).toBe("failing");
  });

  it("maps needs_attention to degraded", () => {
    expect(healthStateToStatus("needs_attention")).toBe("degraded");
  });

  it("falls back to degraded for unknown or empty states — never a false healthy", () => {
    expect(healthStateToStatus("")).toBe("degraded");
    expect(healthStateToStatus("brand_new_server_state")).toBe("degraded");
    expect(healthStateToStatus(undefined as unknown as string)).toBe("degraded");
  });
});

describe("normalizeIntegrationRows — display fields", () => {
  it("keeps the catalog's casing instead of re-capitalising it", () => {
    const rows = normalizeIntegrationRows({
      items: [{ slug: "ebay", name: "eBay", connected: true, health_state: "healthy" }],
    });
    expect(rows[0]?.name).toBe("eBay");
    expect(rows[0]?.slug).toBe("ebay");
  });

  it("falls back to the slug when no name is sent", () => {
    const rows = normalizeIntegrationRows({
      items: [{ slug: "discord", connected: true, health_state: "healthy" }],
    });
    expect(rows[0]?.name).toBe("discord");
  });

  it("preserves manage_path, health_message and category", () => {
    const rows = normalizeIntegrationRows({
      items: [
        {
          slug: "shopify",
          name: "Shopify",
          connected: true,
          health_state: "needs_attention",
          category: "commerce",
          health_message: "Reconnect to restore order sync.",
          manage_path: "/app/integrations/shopify",
          last_sync_at: "2026-07-20T10:00:00Z",
        },
      ],
    });
    expect(rows[0]).toMatchObject({
      category: "commerce",
      health_message: "Reconnect to restore order sync.",
      manage_path: "/app/integrations/shopify",
      last_delivery_at: "2026-07-20T10:00:00Z",
      status: "degraded",
    });
  });

  it("omits optional fields entirely rather than setting empty strings", () => {
    const rows = normalizeIntegrationRows({ items: [connected] });
    expect(rows[0]).not.toHaveProperty("manage_path");
    expect(rows[0]).not.toHaveProperty("health_message");
    expect(rows[0]).not.toHaveProperty("last_delivery_at");
  });

  it("synthesises a stable id when the row has neither slug nor id", () => {
    const rows = normalizeIntegrationRows({
      items: [{ connected: true, health_state: "healthy" }],
    });
    expect(rows[0]?.id).toBe("integration-0");
  });
});

describe("countByStatus", () => {
  it("counts each bucket", () => {
    const rows = normalizeIntegrationRows({
      items: [
        { slug: "a", connected: true, health_state: "healthy" },
        { slug: "b", connected: true, health_state: "needs_attention" },
        { slug: "c", connected: true, health_state: "action_required" },
        { slug: "d", connected: true, health_state: "action_required" },
      ],
    });
    expect(countByStatus(rows)).toEqual({ healthy: 1, degraded: 1, failing: 2 });
  });

  it("is all zeroes for an empty list", () => {
    expect(countByStatus([])).toEqual({ healthy: 0, degraded: 0, failing: 0 });
  });
});

describe("titleCaseSlug", () => {
  it("capitalises a slug", () => {
    expect(titleCaseSlug("slack")).toBe("Slack");
  });

  it("falls back for an empty slug", () => {
    expect(titleCaseSlug("  ")).toBe("Integration");
  });
});

describe("manageUrl", () => {
  it("resolves a relative path against the workspace base", () => {
    expect(
      manageUrl("/app/integrations/shopify", "https://api.example.test"),
    ).toBe("https://api.example.test/app/integrations/shopify");
  });

  it("returns null with no path or no base", () => {
    expect(manageUrl(undefined, "https://api.example.test")).toBeNull();
    expect(manageUrl("/app/x", null)).toBeNull();
  });

  it("refuses a cross-origin absolute path", () => {
    expect(
      manageUrl("https://evil.test/app/x", "https://api.example.test"),
    ).toBeNull();
  });

  it("refuses a non-http scheme", () => {
     
    expect(manageUrl("javascript:alert(1)", "https://api.example.test")).toBeNull();
  });

  it("returns null on a malformed base", () => {
    expect(manageUrl("/app/x", "not a url")).toBeNull();
  });
});

describe("connection ids reach the client (INTEG#1)", () => {
  // The Go Connection struct declares primary_connection_id and connection_ids
  // (integrations/handlers.go:54-55) and applyRuntimeConnectionIDs fills them on
  // the LIST path (:465). This normalizer used to drop both, which is why no
  // lifecycle verb was reachable: retry/pause/resume/disconnect all address a
  // connection by id.
  const row = (extra: Record<string, unknown>) => ({
    slug: "hubspot",
    name: "HubSpot",
    health_state: "healthy",
    connected: true,
    count: 1,
    ...extra,
  });

  it("carries the primary connection id", () => {
    const [parsed] = normalizeIntegrationRows([
      row({ primary_connection_id: "conn_123" }),
    ]);
    expect(parsed?.primary_connection_id).toBe("conn_123");
  });

  it("carries every connection id, since a tenant may hold several", () => {
    const [parsed] = normalizeIntegrationRows([
      row({ connection_ids: ["conn_1", "conn_2"] }),
    ]);
    expect(parsed?.connection_ids).toEqual(["conn_1", "conn_2"]);
  });

  it("falls back to the sole connection id when the server omits the primary", () => {
    // The server omits primary_connection_id when there is exactly one row, and a
    // verb addressed at that row is unambiguous.
    const [parsed] = normalizeIntegrationRows([row({ connection_ids: ["only_1"] })]);
    expect(parsed?.primary_connection_id).toBe("only_1");
  });

  it("omits the fields entirely rather than inventing an empty id", () => {
    // An empty-string id would be concatenated into
    // /api/v1/crm/integrations//sync, which chi resolves to a DIFFERENT route.
    const [parsed] = normalizeIntegrationRows([row({})]);
    expect(parsed?.primary_connection_id).toBeUndefined();
    expect(parsed?.connection_ids).toBeUndefined();
  });

  it("survives a malformed connection_ids payload", () => {
    const [fromString] = normalizeIntegrationRows([row({ connection_ids: "nope" })]);
    expect(fromString?.connection_ids).toBeUndefined();
    const [mixed] = normalizeIntegrationRows([
      row({ connection_ids: ["good", 42, "", "  ", null, " spaced "] }),
    ]);
    expect(mixed?.connection_ids).toEqual(["good", "spaced"]);
  });
});
