import { describe, expect, it } from "vitest";

import {
  MCP_EXECUTION_OVERLAY,
  mcpHistoryRouteView,
  routeWithMcpHistoryView,
} from "../../components/mcp/mcp-route-state";
import type { DesktopRoute } from "../../lib/desktop-router";

describe("MCP route state", () => {
  it("restores strict history filters and a selected execution", () => {
    const route: DesktopRoute = {
      section: "mcp",
      tab: "history",
      filters: [
        { key: "history-window", value: "24h" },
        { key: "history-source", value: "all" },
        { key: "history-tool", value: "campaigns_send" },
      ],
      overlay: { name: MCP_EXECUTION_OVERLAY, resourceId: "42" },
    };

    expect(mcpHistoryRouteView(route)).toEqual({
      window: "24h",
      include: "all",
      tool: "campaigns_send",
      selectedId: 42,
      needsNormalization: false,
    });
  });

  it("fail-closes duplicate, oversized, and malformed route values", () => {
    const route: DesktopRoute = {
      section: "mcp",
      tab: "history",
      filters: [
        { key: "history-window", value: "forever" },
        { key: "history-window", value: "24h" },
        { key: "history-source", value: "native" },
        { key: "history-tool", value: "campaigns send --unsafe" },
      ],
      overlay: {
        name: MCP_EXECUTION_OVERLAY,
        resourceId: "9007199254740992",
      },
    };

    expect(mcpHistoryRouteView(route)).toEqual({
      window: "7d",
      include: "mcp",
      tool: "",
      selectedId: null,
      needsNormalization: true,
    });
  });

  it("preserves Tools decision state while replacing only History-owned state", () => {
    const route: DesktopRoute = {
      section: "mcp",
      tab: "tools",
      query: "campaign",
      filters: [
        { key: "catalog-category", value: "Campaigns" },
        { key: "history-window", value: "24h" },
        { key: "history-tool", value: "old_tool" },
      ],
      overlay: { name: MCP_EXECUTION_OVERLAY, resourceId: "7" },
    };

    expect(
      routeWithMcpHistoryView(
        route,
        { window: "30d", include: "all", tool: "subscribers_list" },
        null,
      ),
    ).toEqual({
      section: "mcp",
      tab: "history",
      query: "campaign",
      filters: [
        { key: "catalog-category", value: "Campaigns" },
        { key: "history-window", value: "30d" },
        { key: "history-source", value: "all" },
        { key: "history-tool", value: "subscribers_list" },
      ],
    });
  });
});
