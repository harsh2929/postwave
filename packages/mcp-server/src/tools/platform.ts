// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

export function platformTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "asset_upload",
      description:
        "Upload an image to the tenant asset library. Image-only, max 10MB. Returns {id, url, width, height, bytes}.",
      schema: z.object({
        filename: z.string().min(1),
        mime: z.string().min(1),
        content_base64: z.string().min(1),
      }),
      handler: async (input) => {
        try {
          const bytes = decodeBase64(input.content_base64);
          return await client.assets.upload(input.filename, bytes, input.mime);
        } catch (err) {
          throw wrap("asset_upload", err);
        }
      },
    },
    {
      name: "asset_list",
      description:
        "List recent assets (cursor-paginated). Optional limit and before-id cursor.",
      schema: z.object({
        limit: z.number().int().positive().max(200).optional(),
        before: z.string().optional(),
      }),
      handler: async (input) => {
        try {
          return await client.assets.list(input);
        } catch (err) {
          throw wrap("asset_list", err);
        }
      },
    },
    {
      name: "asset_delete",
      description: "Soft-delete an asset by id.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async (input) => {
        try {
          await client.assets.delete(input.id);
          return { ok: true };
        } catch (err) {
          throw wrap("asset_delete", err);
        }
      },
    },
    {
      name: "inbound_webhook_create",
      description:
        "Create a tenant-scoped inbound webhook endpoint. Returns slug + plaintext signing secret (shown once).",
      schema: z.object({ name: z.string().optional() }),
      handler: async (input) => {
        try {
          return await client.inboundWebhooks.create(input);
        } catch (err) {
          throw wrap("inbound_webhook_create", err);
        }
      },
    },
    {
      name: "inbound_webhook_list",
      description:
        "List the tenant's inbound webhook endpoints (without secrets).",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.inboundWebhooks.list();
        } catch (err) {
          throw wrap("inbound_webhook_list", err);
        }
      },
    },
    {
      name: "inbound_webhook_delete",
      description: "Revoke an inbound webhook endpoint by id.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async (input) => {
        try {
          await client.inboundWebhooks.delete(input.id);
          return { ok: true };
        } catch (err) {
          throw wrap("inbound_webhook_delete", err);
        }
      },
    },
    {
      name: "track_event",
      description:
        "Record a product event for a subscriber. Pass either subscriber_id or email; supply event_name and an optional properties object. Triggers automations of kind product_event.",
      schema: z.object({
        subscriber_id: z.string().optional(),
        email: z.string().email().optional(),
        event_name: z.string().min(1),
        properties: z.record(z.unknown()).optional(),
        occurred_at: z.string().optional(),
      }),
      handler: async (input) => {
        try {
          return await client.track.track(input);
        } catch (err) {
          throw wrap("track_event", err);
        }
      },
    },
    {
      name: "track_events_list",
      description: "List recent product events for a subscriber.",
      schema: z.object({
        subscriber_id: z.string().min(1),
        limit: z.number().int().positive().max(500).optional(),
      }),
      handler: async (input) => {
        try {
          return await client.track.listEvents(input);
        } catch (err) {
          throw wrap("track_events_list", err);
        }
      },
    },
    {
      name: "inbound_email_list",
      description:
        "List inbound emails. Optionally filter by subscriber_id or campaign_id.",
      schema: z.object({
        subscriber_id: z.string().optional(),
        campaign_id: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      }),
      handler: async (input) => {
        try {
          return await client.inboundEmails.list(input);
        } catch (err) {
          throw wrap("inbound_email_list", err);
        }
      },
    },
    {
      name: "inbound_email_endpoint_get",
      description:
        "Get inbound-email endpoint metadata. Never returns or decrypts the signing secret.",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.inboundEmails.getEndpoint();
        } catch (err) {
          throw wrap("inbound_email_endpoint_get", err);
        }
      },
    },
    {
      name: "inbound_email_endpoint_rotate",
      description:
        "Create or rotate the inbound-email signing secret. Returns the plaintext secret once; copy it immediately.",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.inboundEmails.rotateEndpoint();
        } catch (err) {
          throw wrap("inbound_email_endpoint_rotate", err);
        }
      },
    },
    {
      name: "dmarc_reports_list",
      description:
        "List parsed DMARC aggregate reports. Optional domain, from/to ISO timestamps, and limit.",
      schema: z.object({
        domain: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      }),
      handler: async (input) => {
        try {
          return await client.dmarc.list(input);
        } catch (err) {
          throw wrap("dmarc_reports_list", err);
        }
      },
    },
  ];
}

function decodeBase64(s: string): Uint8Array {
  if (typeof Buffer !== "undefined")
    return new Uint8Array(Buffer.from(s, "base64"));
  const atob = (globalThis as { atob?: (value: string) => string }).atob;
  const bin = atob ? atob(s) : "";
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function wrap(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
