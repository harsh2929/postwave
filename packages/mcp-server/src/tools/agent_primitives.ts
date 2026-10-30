// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

export function agentPrimitiveTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "audit_query",
      description:
        "Query the tenant audit log. All filters optional. `since` is ISO-8601. Returns cursor-paginated entries (actor, action, resource, metadata, timestamp).",
      schema: z.object({
        actor_type: z.string().optional(),
        actor_label: z.string().optional(),
        action: z.string().optional(),
        resource_type: z.string().optional(),
        since: z.string().optional(),
        cursor: z.string().optional(),
      }),
      handler: async (params) => {
        try {
          return await client.audit.query(params);
        } catch (err) {
          throw wrapErr("audit_query", err);
        }
      },
    },
    {
      name: "approvals_list",
      description:
        "List human-approval requests for the tenant. Optional `status` filter (pending/approved/rejected/expired). Cursor-paginated.",
      schema: z.object({
        status: z.enum(["pending", "approved", "rejected", "expired"]).optional(),
        cursor: z.string().optional(),
      }),
      handler: async (params) => {
        try {
          return await client.approvals.list(params);
        } catch (err) {
          throw wrapErr("approvals_list", err);
        }
      },
    },
    {
      name: "approvals_decide",
      description:
        "Approve or reject a pending approval request by id. `decision` is 'approve' or 'reject'. Optional `notes` are stored on the audit entry.",
      schema: z.object({
        id: z.string().min(1),
        decision: z.enum(["approve", "reject"]),
        notes: z.string().optional(),
      }),
      handler: async ({ id, decision, notes }) => {
        try {
          return await client.approvals.decide(id, { decision, notes });
        } catch (err) {
          throw wrapErr("approvals_decide", err);
        }
      },
    },
    {
      name: "sandbox_status",
      description:
        "Status of a sandbox campaign run: state (scheduled/running/completed), the simulated event stream so far, and remaining scheduled deliveries. Use to inspect a dry-run before promoting to a live send.",
      schema: z.object({
        campaign_id: z.string().min(1),
      }),
      handler: async ({ campaign_id }) => {
        try {
          return await client.sandbox.status(campaign_id);
        } catch (err) {
          throw wrapErr("sandbox_status", err);
        }
      },
    },
    {
      name: "cost_aggregate",
      description:
        "Aggregate the cost ledger since `since` (ISO-8601), grouped by api_key_id, kind, day, or actor_label. Returns buckets with total_cents and count per group.",
      schema: z.object({
        since: z.string().min(1),
        group_by: z.enum(["api_key_id", "kind", "day", "actor_label"]),
      }),
      handler: async ({ since, group_by }) => {
        try {
          return await client.cost.aggregate({ since, group_by });
        } catch (err) {
          throw wrapErr("cost_aggregate", err);
        }
      },
    },
    {
      name: "safety_check",
      description:
        "Pre-send safety eval for a draft message. Runs the same gating evaluator the send pipeline uses. Returns blocking flag plus per-finding severity (low/medium/high/block).",
      schema: z.object({
        subject: z.string().min(1),
        body_html: z.string().min(1),
        body_text: z.string().min(1),
        intended_audience_count: z.number().int().min(0),
      }),
      handler: async (input) => {
        try {
          return await client.safety.check(input);
        } catch (err) {
          throw wrapErr("safety_check", err);
        }
      },
    },
  ];
}

function wrapErr(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
