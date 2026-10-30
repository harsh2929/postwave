// SPDX-License-Identifier: AGPL-3.0-only

import { MCP_CATEGORY_COUNT, MCP_TOOL_COUNT } from "@/lib/mcp-catalog-stats";

/** Public distribution truth shared by every active MCP marketing/docs route. */
export const MCP_RELEASE_HELD = true as const;
export const MCP_RELEASE_HOLD_CODE = "mcp_distribution_release_held" as const;

/** Counts identify the mutable repository catalogue, never installed tools. */
export const MCP_SOURCE_CANDIDATE_TOOL_COUNT = MCP_TOOL_COUNT;
export const MCP_SOURCE_CANDIDATE_CATEGORY_COUNT = MCP_CATEGORY_COUNT;
export const MCP_SOURCE_CANDIDATE_LABEL = `${MCP_SOURCE_CANDIDATE_TOOL_COUNT} source-candidate definitions across ${MCP_SOURCE_CANDIDATE_CATEGORY_COUNT} categories`;

export const MCP_RELEASE_STATUS_COPY =
  "Distribution is release-held. The repository catalogue is a mutable source candidate, not a published-artifact or deployed-runtime inventory. No production install, hosted connector, or working-key setup is currently supported.";

/** Exact boundary for the adjacent in-app agent route family. */
export const AGENT_INTERACTIVE_RELEASE_HELD = true as const;
export const AGENT_INTERACTIVE_RELEASE_HOLD_CODE =
  "agent_interactive_release_held" as const;
export const AGENT_INTERACTIVE_RELEASE_STATUS_COPY =
  "The entire /api/v1/ai-agent/* family is release-held behind a private, no-store 503 before session storage, BYOK resolution, provider calls, or tool execution. Checked-in chat, session, config, budget, streaming, and telemetry code is future source evidence only; no working preview is available.";
