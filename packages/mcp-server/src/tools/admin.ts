// SPDX-License-Identifier: MIT
import { z } from "zod";
import { API_KEY_SCOPES, type PostwaveClient } from "@postwave/sdk";

import { validateUrl } from "../lib/security.js";
import type { AnyToolDef } from "../lib/register.js";

// Kept as a runtime tuple because MCP schemas must validate before invoking the
// SDK. The cross-surface OpenAPI contract test compares this exact list against
// the published spec and both SDKs, so a new topic cannot drift silently.
export const MCP_OUTBOUND_WEBHOOK_EVENT_TYPES = [
  "campaign.sent",
  "subscriber.added",
  "subscriber.removed",
  "subscriber.unsubscribed",
  "approval.requested",
  "approval.decided",
  "audit.created",
  "bounce.received",
  "list_health.degraded",
  "list.subscriber.added",
  "email.bounced",
  "email.complained",
  "email.delivered",
  "assurance.run.completed",
  "assurance.run.blocked",
] as const;

const WebhookEventEnum = z.enum(MCP_OUTBOUND_WEBHOOK_EVENT_TYPES);

const APIKeyScopeEnum = z.enum(API_KEY_SCOPES);

const ChatIntegrationProviderEnum = z.enum(["slack", "discord", "teams"]);

export function adminTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "webhook_create",
      description:
        "Create an outbound webhook subscription. URL is SSRF-validated. Returns the WebhookSubscription plus the plaintext signing secret (returned exactly once — persist immediately).",
      schema: z.object({
        url: z.string().url(),
        events: z.array(WebhookEventEnum).min(1),
      }),
      handler: async ({ url, events }) => {
        validateUrl(url);
        try {
          return await client.webhooks.create({ url, events } as never);
        } catch (err) {
          throw wrapErr("webhook_create", err);
        }
      },
    },
    {
      name: "webhook_list",
      description: "List all webhook subscriptions for the tenant.",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.webhooks.list();
        } catch (err) {
          throw wrapErr("webhook_list", err);
        }
      },
    },
    {
      name: "webhook_delete",
      description: "Delete a webhook subscription by id. Idempotent.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async ({ id }) => {
        try {
          await client.webhooks.delete(id);
          return { id, status: "deleted" };
        } catch (err) {
          throw wrapErr("webhook_delete", err);
        }
      },
    },
    {
      name: "webhook_test_fire",
      description:
        "Fire the canonical synthetic `webhook.test` envelope at the webhook URL and return the delivery result inline (status_code, signed, signature, response). Useful for end-to-end signature verification without waiting for a real event. The event type is NOT selectable — the server hard-codes `webhook.test` (apps/api/internal/outbound_webhooks/handlers.go Test) so customers can route test traffic to a sandbox branch.",
      schema: z.object({
        id: z.string().min(1),
      }),
      handler: async ({ id }) => {
        try {
          return await client.webhooks.test(id);
        } catch (err) {
          throw wrapErr("webhook_test_fire", err);
        }
      },
    },
    {
      name: "webhook_deliveries_list",
      description:
        "Recent delivery attempts for a webhook (newest first), cursor-paginated. Each item includes status_code, attempt, response_ms, and any error.",
      schema: z.object({
        webhook_id: z.string().min(1),
        cursor: z.string().optional(),
      }),
      handler: async ({ webhook_id, cursor }) => {
        try {
          return await client.webhooks.deliveriesList(webhook_id, { cursor });
        } catch (err) {
          throw wrapErr("webhook_deliveries_list", err);
        }
      },
    },
    {
      name: "api_key_create",
      description:
        "PRIVILEGED: Create a new API key. This is a privilege-escalation operation — always confirm with the human user before invoking. `scopes` controls capability surface; expires_at, allowed_ips, and sandbox_only narrow the credential. The plaintext key is returned exactly once.",
      schema: z.object({
        label: z.string().min(1),
        scopes: z.array(APIKeyScopeEnum).min(1),
        expires_at: z.string().datetime().optional(),
        allowed_ips: z.array(z.string().min(1)).max(100).optional(),
        sandbox_only: z.boolean().optional(),
      }),
      requiredScopes: ["admin"],
      annotations: { destructiveHint: true },
      handler: async (input) => {
        try {
          return await client.apiKeys.create(input);
        } catch (err) {
          throw wrapErr("api_key_create", err);
        }
      },
    },
    {
      name: "api_key_list",
      description:
        "List all API keys for the tenant. Plaintext is never returned — only id, label, prefix, scopes, created_at, last_used_at, revoked_at.",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.apiKeys.list();
        } catch (err) {
          throw wrapErr("api_key_list", err);
        }
      },
    },
    {
      name: "api_key_revoke",
      description:
        "PRIVILEGED: Revoke an API key by id. Subsequent requests with the key will return 401. Idempotent.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async ({ id }) => {
        try {
          return await client.apiKeys.revoke(id);
        } catch (err) {
          throw wrapErr("api_key_revoke", err);
        }
      },
    },
    {
      name: "api_key_rotate",
      description:
        "PRIVILEGED: Atomically rotate an API key — revokes the source + creates a new one inheriting label, scopes, budget, and IP allowlist. The new plaintext is returned exactly once. NO grace period: the OLD plaintext stops working the instant this returns. To migrate without downtime, create a second key first, deploy callers, then revoke the original.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async ({ id }) => {
        try {
          return await client.apiKeys.rotate(id);
        } catch (err) {
          throw wrapErr("api_key_rotate", err);
        }
      },
    },
    {
      name: "slack_integration_create",
      description:
        "Register a Slack incoming-webhook integration. URL is envelope-encrypted server-side; reads return only channel hint + delivery status. Specify which Moosewave events should be relayed.",
      schema: z.object({
        url: z.string().url(),
        events: z.array(WebhookEventEnum).min(1),
        channel_hint: z.string().optional(),
      }),
      handler: async (input) => {
        validateUrl(input.url);
        try {
          return await client.slackIntegrations.create({
            url: input.url,
            events: input.events,
            channel_hint: input.channel_hint,
          });
        } catch (err) {
          throw wrapErr("slack_integration_create", err);
        }
      },
    },
    {
      name: "slack_integration_list",
      description:
        "List the tenant's Slack integrations (URL is never returned by reads).",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.slackIntegrations.list();
        } catch (err) {
          throw wrapErr("slack_integration_list", err);
        }
      },
    },
    {
      name: "slack_integration_delete",
      description: "Delete a Slack integration by id.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async ({ id }) => {
        try {
          return await client.slackIntegrations.delete(id);
        } catch (err) {
          throw wrapErr("slack_integration_delete", err);
        }
      },
    },
    {
      name: "chat_integration_create",
      description:
        "Register a Slack, Discord, or Teams incoming-webhook integration. URL is envelope-encrypted server-side; reads return only channel hint + delivery status.",
      schema: z.object({
        provider: ChatIntegrationProviderEnum,
        url: z.string().url(),
        events: z.array(WebhookEventEnum).min(1),
        channel_hint: z.string().optional(),
      }),
      handler: async ({ provider, url, events, channel_hint }) => {
        validateUrl(url);
        try {
          return await client.chatIntegrations.forProvider(provider).create({
            url,
            events,
            channel_hint,
          });
        } catch (err) {
          throw wrapErr("chat_integration_create", err);
        }
      },
    },
    {
      name: "chat_integration_list",
      description:
        "List Slack, Discord, or Teams integrations. URLs are never returned.",
      schema: z.object({ provider: ChatIntegrationProviderEnum }),
      handler: async ({ provider }) => {
        try {
          return await client.chatIntegrations.forProvider(provider).list();
        } catch (err) {
          throw wrapErr("chat_integration_list", err);
        }
      },
    },
    {
      name: "chat_integration_update",
      description:
        "Update a Slack, Discord, or Teams integration: rotate URL, channel hint, events, or enabled state.",
      schema: z.object({
        provider: ChatIntegrationProviderEnum,
        id: z.string().min(1),
        url: z.string().url().optional(),
        events: z.array(WebhookEventEnum).min(1).optional(),
        channel_hint: z.string().optional(),
        enabled: z.boolean().optional(),
      }),
      handler: async ({ provider, id, url, events, channel_hint, enabled }) => {
        if (url) validateUrl(url);
        if (
          !url &&
          !events &&
          channel_hint === undefined &&
          enabled === undefined
        ) {
          throw new Error(
            "chat_integration_update: pass url, events, channel_hint, or enabled",
          );
        }
        try {
          return await client.chatIntegrations
            .forProvider(provider)
            .update(id, {
              url,
              events,
              channel_hint,
              enabled,
            });
        } catch (err) {
          throw wrapErr("chat_integration_update", err);
        }
      },
    },
    {
      name: "chat_integration_delete",
      description: "Delete a Slack, Discord, or Teams integration by id.",
      schema: z.object({
        provider: ChatIntegrationProviderEnum,
        id: z.string().min(1),
      }),
      handler: async ({ provider, id }) => {
        try {
          return await client.chatIntegrations.forProvider(provider).delete(id);
        } catch (err) {
          throw wrapErr("chat_integration_delete", err);
        }
      },
    },
    {
      name: "landing_page_create",
      description:
        "Create a landing page in 'draft' status. Slug must be lowercase alphanumeric or dashes (max 64 chars).",
      schema: z.object({
        slug: z.string().min(1).max(64),
        name: z.string().min(1),
        domain: z.string().optional(),
        template: z.string().optional(),
      }),
      handler: async (input) => {
        try {
          return await client.landingPages.create(input);
        } catch (err) {
          throw wrapErr("landing_page_create", err);
        }
      },
    },
    {
      name: "landing_page_list",
      description: "List the tenant's landing pages (newest-first).",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.landingPages.list();
        } catch (err) {
          throw wrapErr("landing_page_list", err);
        }
      },
    },
    {
      name: "landing_page_publish",
      description: "Publish a landing page (status -> 'published').",
      schema: z.object({ id: z.string().min(1) }),
      handler: async ({ id }) => {
        try {
          return await client.landingPages.update(id, { status: "published" });
        } catch (err) {
          throw wrapErr("landing_page_publish", err);
        }
      },
    },
    {
      name: "campaign_report",
      description:
        "Aggregate analytics for a campaign — sent / delivered / opens / unique_opens / clicks / bounces / complaints / unsubscribes plus computed rates and the top-5 clicked links. Reads from campaign_report_events at query time.",
      schema: z.object({ campaign_id: z.string().min(1) }),
      handler: async ({ campaign_id }) => {
        try {
          return await client.analytics.campaignReport(campaign_id);
        } catch (err) {
          throw wrapErr("campaign_report", err);
        }
      },
    },
    {
      name: "dashboard_stats",
      description:
        "Tenant overview: total subscribers + 30-day rolling rollups (added, unsubbed, campaigns sent, opens, clicks, bounces).",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.analytics.dashboardStats();
        } catch (err) {
          throw wrapErr("dashboard_stats", err);
        }
      },
    },
    {
      name: "sequence_job_wait",
      description:
        "Block until a sequence-generation job (returned from generate() or regenerate() in async mode) reaches a terminal status — 'succeeded' (sequence_id populated) or 'failed' (error_message populated). Polls every 2s, 5min default timeout.",
      // The MCP-level timeout must exceed the inner poll budget, or the
      // 30s default would kill the call long before the 5-min poll
      // completes (and before any caller-supplied timeout_ms up to ~10min).
      timeoutMs: 10 * 60_000,
      schema: z.object({
        job_id: z.string().min(1),
        timeout_ms: z.number().int().positive().optional(),
      }),
      handler: async ({ job_id, timeout_ms }) => {
        try {
          return await client.sequences.waitForJob(job_id, {
            timeoutMs: timeout_ms,
          });
        } catch (err) {
          throw wrapErr("sequence_job_wait", err);
        }
      },
    },
  ];
}

function wrapErr(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
