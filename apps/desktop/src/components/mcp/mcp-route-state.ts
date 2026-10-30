import type { DesktopRoute } from "../../lib/desktop-router";
import type { McpHistoryWindow } from "./mcp-display";
import { safeMcpToolName } from "./mcp-execution-security";

const WINDOW_FILTER = "history-window";
const SOURCE_FILTER = "history-source";
const TOOL_FILTER = "history-tool";

export const MCP_EXECUTION_OVERLAY = "mcp-execution-detail";

export interface McpHistoryRouteView {
  window: McpHistoryWindow;
  include: "mcp" | "all";
  tool: string;
  selectedId: number | null;
  needsNormalization: boolean;
}

export function validMcpToolFilter(value: string): boolean {
  return (
    value === "" || (value.length <= 96 && safeMcpToolName(value) === value)
  );
}

export function mcpHistoryRouteView(route: DesktopRoute): McpHistoryRouteView {
  if (route.section !== "mcp") {
    return {
      window: "7d",
      include: "mcp",
      tool: "",
      selectedId: null,
      needsNormalization: false,
    };
  }
  const values = (key: string): string[] =>
    (route.filters ?? [])
      .filter((entry) => entry.key === key)
      .map((entry) => entry.value);
  const windowValues = values(WINDOW_FILTER);
  const sourceValues = values(SOURCE_FILTER);
  const toolValues = values(TOOL_FILTER);
  const rawWindow = windowValues[0];
  const rawSource = sourceValues[0];
  const window: McpHistoryWindow = ["24h", "7d", "30d"].includes(
    rawWindow ?? "",
  )
    ? (rawWindow as McpHistoryWindow)
    : "7d";
  const include = rawSource === "all" ? "all" : "mcp";
  const rawTool = (toolValues[0] ?? "").trim();
  const tool = validMcpToolFilter(rawTool) ? rawTool : "";
  const rawSelectedId =
    route.overlay?.name === MCP_EXECUTION_OVERLAY
      ? route.overlay.resourceId
      : undefined;
  const parsedSelectedId =
    rawSelectedId && /^\d{1,16}$/u.test(rawSelectedId)
      ? Number(rawSelectedId)
      : Number.NaN;
  const selectedId =
    Number.isSafeInteger(parsedSelectedId) && parsedSelectedId > 0
      ? parsedSelectedId
      : null;
  return {
    window,
    include,
    tool,
    selectedId,
    needsNormalization:
      windowValues.length > 1 ||
      sourceValues.length > 1 ||
      toolValues.length > 1 ||
      (rawWindow !== undefined && !["24h", "7d", "30d"].includes(rawWindow)) ||
      (rawSource !== undefined && !["mcp", "all"].includes(rawSource)) ||
      rawTool !== tool ||
      (route.overlay?.name === MCP_EXECUTION_OVERLAY && selectedId === null),
  };
}

export function routeWithMcpHistoryView(
  route: DesktopRoute,
  view: Pick<McpHistoryRouteView, "window" | "include" | "tool">,
  overlay: DesktopRoute["overlay"] | null,
): DesktopRoute {
  const owned = new Set([WINDOW_FILTER, SOURCE_FILTER, TOOL_FILTER]);
  const retainedFilters =
    route.section === "mcp"
      ? (route.filters ?? []).filter((entry) => !owned.has(entry.key))
      : [];
  const filters = [
    ...retainedFilters,
    ...(view.window === "7d"
      ? []
      : [{ key: WINDOW_FILTER, value: view.window }]),
    ...(view.include === "mcp"
      ? []
      : [{ key: SOURCE_FILTER, value: view.include }]),
    ...(view.tool ? [{ key: TOOL_FILTER, value: view.tool }] : []),
  ];
  const next: DesktopRoute = {
    ...(route.section === "mcp" ? route : { section: "mcp" as const }),
    section: "mcp",
    tab: "history",
    filters: filters.length > 0 ? filters : undefined,
  };
  if (overlay) next.overlay = overlay;
  else delete next.overlay;
  return next;
}
