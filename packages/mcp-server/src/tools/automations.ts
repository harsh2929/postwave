// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

const TriggerSpecSchema = z.object({
  type: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

const NodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

const EdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  branch: z.string().optional(),
});

export function automationTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "automation_create",
      description:
        "Create a new automation graph. Provide `name`, an array of `triggers`, and a graph of `nodes`+`edges`. Each node has an id, type (e.g. 'send_email', 'wait', 'branch'), and config. Returns the automation in 'draft' status.",
      schema: z.object({
        name: z.string().min(1),
        triggers: z.array(TriggerSpecSchema).min(1),
        nodes: z.array(NodeSchema).min(1),
        edges: z.array(EdgeSchema),
      }),
      handler: async (input) => {
        try {
          return await client.automations.create(input);
        } catch (err) {
          throw wrapErr("automation_create", err);
        }
      },
    },
    {
      name: "automation_list",
      description:
        "List automations for the tenant. Optional `status` filter (draft/active/paused). Cursor-paginated.",
      schema: z.object({
        status: z.enum(["draft", "active", "paused"]).optional(),
        cursor: z.string().optional(),
      }),
      handler: async ({ status, cursor }) => {
        try {
          return await client.automations.list({ status, cursor });
        } catch (err) {
          throw wrapErr("automation_list", err);
        }
      },
    },
    {
      name: "automation_update",
      description:
        "Patch an existing automation. Pass any subset of name/status/triggers/nodes/edges in `patch`. Returns the updated automation.",
      schema: z.object({
        id: z.string().min(1),
        patch: z
          .object({
            name: z.string().optional(),
            status: z.enum(["draft", "active", "paused"]).optional(),
            triggers: z.array(TriggerSpecSchema).optional(),
            nodes: z.array(NodeSchema).optional(),
            edges: z.array(EdgeSchema).optional(),
          })
          .describe("Partial automation patch."),
      }),
      handler: async ({ id, patch }) => {
        try {
          return await client.automations.update(id, patch);
        } catch (err) {
          throw wrapErr("automation_update", err);
        }
      },
    },
    {
      name: "automation_create_behavioral_trigger",
      description:
        "Wire a behavioral trigger (campaign open/no-open, link click/no-click, page visit, no-activity) to an existing automation. Provide automation_id and trigger_type. campaign_id, url_pattern, within_days, after_days are trigger-specific knobs.",
      schema: z.object({
        automation_id: z.string().min(1),
        trigger_type: z.enum([
          "campaign_opened",
          "campaign_not_opened",
          "link_clicked",
          "no_link_clicked",
          "page_visited",
          "no_activity",
        ]),
        campaign_id: z.string().optional(),
        url_pattern: z.string().optional(),
        within_days: z.number().int().min(1).max(365).optional(),
        after_days: z.number().int().min(1).max(365).optional(),
      }),
      handler: async ({ automation_id, ...rest }) => {
        try {
          return await client.automations.createBehavioralTrigger(automation_id, rest);
        } catch (err) {
          throw wrapErr("automation_create_behavioral_trigger", err);
        }
      },
    },
  ];
}

function wrapErr(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
