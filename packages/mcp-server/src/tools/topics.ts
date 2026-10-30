// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

export function topicTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "topic_create",
      description:
        "Create a preference topic (slug + display name). Optional description, default_opt_in (whether new subscribers are auto-opted-in). Returns the persisted Topic.",
      schema: z.object({
        slug: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        default_opt_in: z.boolean().optional(),
      }),
      handler: async (args) => {
        try {
          return await client.topics.create(args);
        } catch (err) {
          throw wrapErr("topic_create", err);
        }
      },
    },
    {
      name: "topic_list",
      description: "List all preference topics for the tenant. Returns an array of Topic records.",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.topics.list();
        } catch (err) {
          throw wrapErr("topic_list", err);
        }
      },
    },
    {
      name: "topic_delete",
      description:
        "Delete a preference topic by id. Existing per-subscriber opt-ins are removed. Idempotent.",
      schema: z.object({
        id: z.string().min(1),
      }),
      handler: async ({ id }) => {
        try {
          return await client.topics.delete(id);
        } catch (err) {
          throw wrapErr("topic_delete", err);
        }
      },
    },
    {
      name: "topic_subscribe",
      description:
        "Opt a subscriber into a topic. Idempotent. Returns ok on success.",
      schema: z.object({
        subscriber_email: z.string().email(),
        topic_id: z.string().min(1),
      }),
      handler: async ({ subscriber_email, topic_id }) => {
        try {
          return await client.topics.subscribe(subscriber_email, topic_id);
        } catch (err) {
          throw wrapErr("topic_subscribe", err);
        }
      },
    },
    {
      name: "topic_unsubscribe",
      description:
        "Opt a subscriber OUT of a topic. Idempotent. Returns ok on success.",
      schema: z.object({
        subscriber_email: z.string().email(),
        topic_id: z.string().min(1),
      }),
      handler: async ({ subscriber_email, topic_id }) => {
        try {
          return await client.topics.unsubscribe(subscriber_email, topic_id);
        } catch (err) {
          throw wrapErr("topic_unsubscribe", err);
        }
      },
    },
  ];
}

function wrapErr(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
