// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

export function eventTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "events_subscribe",
      description:
        "Register a declarative event subscription. Optional filters: event_types (e.g. ['opened','clicked']), campaign_id, subscriber_email. Returns a subscription_id; matching events flow to the existing `moosewave://events/stream` MCP resource.",
      schema: z.object({
        event_types: z.array(z.string()).optional(),
        campaign_id: z.string().optional(),
        subscriber_email: z.string().email().optional(),
      }),
      handler: async (input) => {
        try {
          return await client.events.subscribe(input);
        } catch (err) {
          throw wrapErr("events_subscribe", err);
        }
      },
    },
  ];
}

function wrapErr(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
