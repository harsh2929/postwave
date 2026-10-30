// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

function wrapErr(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}

const stringOrArray = z.union([z.string(), z.array(z.string())]);

const SendEmailSchema = z
  .object({
    from: z.string().trim().max(320).optional().describe("Sender, e.g. 'Acme <hi@acme.com>'. Defaults to the tenant's configured sender."),
    to: stringOrArray.describe("Recipient address, or an array of addresses."),
    cc: stringOrArray.optional(),
    bcc: stringOrArray.optional(),
    reply_to: stringOrArray.optional(),
    subject: z.string().trim().min(1).max(998),
    html: z.string().optional().describe("HTML body (one of html/text required)."),
    text: z.string().optional().describe("Plain-text body (one of html/text required)."),
    headers: z.record(z.string()).optional().describe("Custom MIME headers, e.g. {\"X-Entity-Ref-ID\":\"abc\"}."),
    tags: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    attachments: z
      .array(
        z.object({
          filename: z.string(),
          content: z.string().optional().describe("base64 file content"),
          path: z.string().optional().describe("remote https URL"),
          content_type: z.string().optional(),
          content_id: z.string().optional(),
        }),
      )
      .optional(),
    scheduled_at: z.string().optional().describe("RFC3339 timestamp; a future value schedules the send."),
  })
  .refine((v) => v.html !== undefined || v.text !== undefined, {
    message: "supply one of html or text",
  });

export function emailTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "emails_send",
      description:
        "Send a single transactional email (Resend-style): from/to/cc/bcc/reply_to + subject + html/text, with optional custom headers, per-message tags, attachments (base64 or remote URL), and scheduled_at for delayed delivery. Suppressed recipients are skipped. Returns {id, status}.",
      schema: SendEmailSchema,
      handler: async (input) => {
        try {
          return await client.emails.send(input as never);
        } catch (err) {
          throw wrapErr("emails_send", err);
        }
      },
    },
    {
      name: "emails_get",
      description: "Fetch the status of one transactional email by id (sent | scheduled | failed | skipped, plus the provider message id).",
      schema: z.object({ id: z.string().min(1) }),
      annotations: { readOnlyHint: true },
      handler: async ({ id }) => {
        try {
          return await client.emails.get(id);
        } catch (err) {
          throw wrapErr("emails_get", err);
        }
      },
    },
    {
      name: "emails_list",
      description: "List the tenant's recent transactional sends (most recent first).",
      schema: z.object({ limit: z.number().int().positive().max(200).optional() }),
      annotations: { readOnlyHint: true },
      handler: async ({ limit }) => {
        try {
          return await client.emails.list(limit ? { limit } : undefined);
        } catch (err) {
          throw wrapErr("emails_list", err);
        }
      },
    },
  ];
}
