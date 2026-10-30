// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

const AppIdSchema = z.object({ app_id: z.string().min(1) });
const PayloadSchema = z.record(z.unknown());
const ReviewSecretSchema = z.string().min(1);
const ReviewDecisionEnum = z.enum(["approve", "reject"]);
const ReviewQueueKindEnum = z.enum(["all", "app", "listing", "partner_profile"]);
const ReviewQueueStateEnum = z.enum(["pending", "resolved", "all"]);

export function developerMarketplaceTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "developer_marketplace_catalog",
      description: "Read developer marketplace catalogs for app types, scopes, webhook topics, OAuth runtime, review policy, and revocation paths.",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.developerMarketplace.catalog();
        } catch (err) {
          throw wrapErr("developer_marketplace_catalog", err);
        }
      },
    },
    {
      name: "developer_marketplace_app_validate",
      description: "Validate a marketplace app draft payload before create/update or review submission.",
      schema: z.object({ payload: PayloadSchema }),
      handler: async ({ payload }) => {
        try {
          return await client.developerMarketplace.validateApp(payload as never);
        } catch (err) {
          throw wrapErr("developer_marketplace_app_validate", err);
        }
      },
    },
    {
      name: "developer_marketplace_app_list",
      description: "List marketplace apps for the current tenant, optionally filtered by status.",
      schema: z.object({ status: z.string().optional() }),
      handler: async ({ status }) => {
        try {
          return await client.developerMarketplace.listApps(status);
        } catch (err) {
          throw wrapErr("developer_marketplace_app_list", err);
        }
      },
    },
    {
      name: "developer_marketplace_app_create",
      description: "Create a marketplace app draft from a JSON payload.",
      schema: z.object({ payload: PayloadSchema }),
      handler: async ({ payload }) => {
        try {
          return await client.developerMarketplace.createApp(payload as never);
        } catch (err) {
          throw wrapErr("developer_marketplace_app_create", err);
        }
      },
    },
    {
      name: "developer_marketplace_app_get",
      description: "Get one marketplace app by id.",
      schema: AppIdSchema,
      handler: async ({ app_id }) => {
        try {
          return await client.developerMarketplace.getApp(app_id);
        } catch (err) {
          throw wrapErr("developer_marketplace_app_get", err);
        }
      },
    },
    {
      name: "developer_marketplace_app_update",
      description: "Update a marketplace app draft from a JSON payload.",
      schema: z.object({ app_id: z.string().min(1), payload: PayloadSchema }),
      handler: async ({ app_id, payload }) => {
        try {
          return await client.developerMarketplace.updateApp(app_id, payload as never);
        } catch (err) {
          throw wrapErr("developer_marketplace_app_update", err);
        }
      },
    },
    {
      name: "developer_marketplace_app_submit_review",
      description: "Submit a marketplace app for review.",
      schema: AppIdSchema,
      handler: async ({ app_id }) => {
        try {
          return await client.developerMarketplace.submitAppReview(app_id);
        } catch (err) {
          throw wrapErr("developer_marketplace_app_submit_review", err);
        }
      },
    },
    {
      name: "developer_marketplace_app_monitoring",
      description: "Read app monitoring: OAuth client state, installs, webhooks, test accounts, token usage, review blockers, and API revision warnings.",
      schema: AppIdSchema,
      handler: async ({ app_id }) => {
        try {
          return await client.developerMarketplace.monitoring(app_id);
        } catch (err) {
          throw wrapErr("developer_marketplace_app_monitoring", err);
        }
      },
    },
    {
      name: "developer_marketplace_oauth_client_list",
      description: "List OAuth clients for a marketplace app.",
      schema: AppIdSchema,
      handler: async ({ app_id }) => {
        try {
          return await client.developerMarketplace.listOAuthClients(app_id);
        } catch (err) {
          throw wrapErr("developer_marketplace_oauth_client_list", err);
        }
      },
    },
    {
      name: "developer_marketplace_oauth_client_create",
      description: "Create an OAuth client for a marketplace app. Plaintext client_secret is returned once.",
      schema: z.object({ app_id: z.string().min(1), payload: PayloadSchema }),
      handler: async ({ app_id, payload }) => {
        try {
          return await client.developerMarketplace.createOAuthClient(app_id, payload as never);
        } catch (err) {
          throw wrapErr("developer_marketplace_oauth_client_create", err);
        }
      },
    },
    {
      name: "developer_marketplace_oauth_client_revoke",
      description: "Revoke one OAuth client for a marketplace app.",
      schema: z.object({ app_id: z.string().min(1), client_id: z.string().min(1) }),
      handler: async ({ app_id, client_id }) => {
        try {
          return await client.developerMarketplace.revokeOAuthClient(app_id, client_id);
        } catch (err) {
          throw wrapErr("developer_marketplace_oauth_client_revoke", err);
        }
      },
    },
    {
      name: "developer_marketplace_test_account_list",
      description: "List test accounts for a marketplace app.",
      schema: AppIdSchema,
      handler: async ({ app_id }) => {
        try {
          return await client.developerMarketplace.listTestAccounts(app_id);
        } catch (err) {
          throw wrapErr("developer_marketplace_test_account_list", err);
        }
      },
    },
    {
      name: "developer_marketplace_test_account_create",
      description: "Create a test account for marketplace review and partner testing.",
      schema: z.object({ app_id: z.string().min(1), payload: PayloadSchema }),
      handler: async ({ app_id, payload }) => {
        try {
          return await client.developerMarketplace.createTestAccount(app_id, payload as never);
        } catch (err) {
          throw wrapErr("developer_marketplace_test_account_create", err);
        }
      },
    },
    {
      name: "developer_marketplace_listing_list",
      description: "List marketplace listings, optionally filtered by category.",
      schema: z.object({ category: z.string().optional() }),
      handler: async ({ category }) => {
        try {
          return await client.developerMarketplace.listListings(category);
        } catch (err) {
          throw wrapErr("developer_marketplace_listing_list", err);
        }
      },
    },
    {
      name: "developer_marketplace_listing_upsert",
      description: "Create or update the marketplace listing for an app.",
      schema: z.object({ app_id: z.string().min(1), payload: PayloadSchema }),
      handler: async ({ app_id, payload }) => {
        try {
          return await client.developerMarketplace.upsertListing(app_id, payload as never);
        } catch (err) {
          throw wrapErr("developer_marketplace_listing_upsert", err);
        }
      },
    },
    {
      name: "developer_marketplace_listing_submit_review",
      description: "Submit a marketplace listing for review.",
      schema: AppIdSchema,
      handler: async ({ app_id }) => {
        try {
          return await client.developerMarketplace.submitListingReview(app_id);
        } catch (err) {
          throw wrapErr("developer_marketplace_listing_submit_review", err);
        }
      },
    },
    {
      name: "developer_marketplace_installation_list",
      description: "List marketplace app installations, optionally filtered by status.",
      schema: z.object({ status: z.string().optional() }),
      handler: async ({ status }) => {
        try {
          return await client.developerMarketplace.listInstallations(status);
        } catch (err) {
          throw wrapErr("developer_marketplace_installation_list", err);
        }
      },
    },
    {
      name: "developer_marketplace_installation_create",
      description: "Install a marketplace app for the current tenant.",
      schema: z.object({ app_id: z.string().min(1), payload: PayloadSchema }),
      handler: async ({ app_id, payload }) => {
        try {
          return await client.developerMarketplace.installApp(app_id, payload as never);
        } catch (err) {
          throw wrapErr("developer_marketplace_installation_create", err);
        }
      },
    },
    {
      name: "developer_marketplace_installation_revoke",
      description: "Revoke a marketplace app installation.",
      schema: z.object({ installation_id: z.string().min(1) }),
      handler: async ({ installation_id }) => {
        try {
          return await client.developerMarketplace.revokeInstallation(installation_id);
        } catch (err) {
          throw wrapErr("developer_marketplace_installation_revoke", err);
        }
      },
    },
    {
      name: "developer_marketplace_webhook_list",
      description: "List app webhook subscriptions for a marketplace app.",
      schema: AppIdSchema,
      handler: async ({ app_id }) => {
        try {
          return await client.developerMarketplace.listWebhookSubscriptions(app_id);
        } catch (err) {
          throw wrapErr("developer_marketplace_webhook_list", err);
        }
      },
    },
    {
      name: "developer_marketplace_webhook_create",
      description: "Create an app webhook subscription for a marketplace app.",
      schema: z.object({ app_id: z.string().min(1), payload: PayloadSchema }),
      handler: async ({ app_id, payload }) => {
        try {
          return await client.developerMarketplace.createWebhookSubscription(app_id, payload as never);
        } catch (err) {
          throw wrapErr("developer_marketplace_webhook_create", err);
        }
      },
    },
    {
      name: "developer_marketplace_partner_profile_list",
      description: "List marketplace partner profiles, optionally filtered by profile type.",
      schema: z.object({ profile_type: z.string().optional() }),
      handler: async ({ profile_type }) => {
        try {
          return await client.developerMarketplace.listPartnerProfiles(profile_type as never);
        } catch (err) {
          throw wrapErr("developer_marketplace_partner_profile_list", err);
        }
      },
    },
    {
      name: "developer_marketplace_partner_profile_upsert",
      description: "Create or update the current tenant's marketplace partner profile.",
      schema: z.object({ payload: PayloadSchema }),
      handler: async ({ payload }) => {
        try {
          return await client.developerMarketplace.upsertPartnerProfile(payload as never);
        } catch (err) {
          throw wrapErr("developer_marketplace_partner_profile_upsert", err);
        }
      },
    },
    {
      name: "developer_marketplace_partner_profile_submit_review",
      description: "Submit the current tenant's partner profile for review.",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.developerMarketplace.submitPartnerProfileReview();
        } catch (err) {
          throw wrapErr("developer_marketplace_partner_profile_submit_review", err);
        }
      },
    },
    {
      name: "developer_marketplace_review_queue",
      description: "Reviewer-only: list pending/resolved app, listing, and partner-profile review items.",
      schema: z.object({
        review_secret: ReviewSecretSchema,
        kind: ReviewQueueKindEnum.optional(),
        state: ReviewQueueStateEnum.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      handler: async ({ review_secret, kind, state, limit }) => {
        try {
          return await client.developerMarketplace.reviewQueue(review_secret, { kind, state, limit });
        } catch (err) {
          throw wrapErr("developer_marketplace_review_queue", err);
        }
      },
    },
    {
      name: "developer_marketplace_review_app_decision",
      description: "Reviewer-only: approve or reject a marketplace app.",
      schema: z.object({
        review_secret: ReviewSecretSchema,
        app_id: z.string().min(1),
        tenant_id: z.string().min(1),
        decision: ReviewDecisionEnum,
        notes: z.string().optional(),
        partner_level: z.string().optional(),
      }),
      handler: async ({ review_secret, app_id, tenant_id, decision, notes, partner_level }) => {
        try {
          return await client.developerMarketplace.reviewAppDecision(
            app_id,
            cleanObject({ tenant_id, decision, notes, partner_level }) as never,
            review_secret,
          );
        } catch (err) {
          throw wrapErr("developer_marketplace_review_app_decision", err);
        }
      },
    },
    {
      name: "developer_marketplace_review_listing_decision",
      description: "Reviewer-only: approve or reject a marketplace listing.",
      schema: z.object({
        review_secret: ReviewSecretSchema,
        app_id: z.string().min(1),
        tenant_id: z.string().min(1),
        decision: ReviewDecisionEnum,
        notes: z.string().optional(),
        partner_level: z.string().optional(),
      }),
      handler: async ({ review_secret, app_id, tenant_id, decision, notes, partner_level }) => {
        try {
          return await client.developerMarketplace.reviewListingDecision(
            app_id,
            cleanObject({ tenant_id, decision, notes, partner_level }) as never,
            review_secret,
          );
        } catch (err) {
          throw wrapErr("developer_marketplace_review_listing_decision", err);
        }
      },
    },
    {
      name: "developer_marketplace_review_partner_profile_decision",
      description: "Reviewer-only: approve or reject a marketplace partner profile.",
      schema: z.object({
        review_secret: ReviewSecretSchema,
        tenant_id: z.string().min(1),
        decision: ReviewDecisionEnum,
        notes: z.string().optional(),
        partner_level: z.string().optional(),
      }),
      handler: async ({ review_secret, tenant_id, decision, notes, partner_level }) => {
        try {
          return await client.developerMarketplace.reviewPartnerProfileDecision(
            tenant_id,
            cleanObject({ decision, notes, partner_level }) as never,
            review_secret,
          );
        } catch (err) {
          throw wrapErr("developer_marketplace_review_partner_profile_decision", err);
        }
      },
    },
    {
      name: "developer_marketplace_oauth_authorize",
      description: "Run marketplace OAuth authorization and return an authorization code and redirect URL.",
      schema: z.object({ payload: PayloadSchema }),
      handler: async ({ payload }) => {
        try {
          return await client.developerMarketplace.authorize(payload as never);
        } catch (err) {
          throw wrapErr("developer_marketplace_oauth_authorize", err);
        }
      },
    },
    {
      name: "developer_marketplace_oauth_token",
      description: "Exchange a marketplace OAuth authorization code for a scoped access token.",
      schema: z.object({ payload: PayloadSchema }),
      handler: async ({ payload }) => {
        try {
          return await client.developerMarketplace.token(payload as never);
        } catch (err) {
          throw wrapErr("developer_marketplace_oauth_token", err);
        }
      },
    },
    {
      name: "developer_marketplace_oauth_revoke",
      description: "Revoke a marketplace OAuth access token.",
      schema: z.object({ payload: PayloadSchema }),
      handler: async ({ payload }) => {
        try {
          return await client.developerMarketplace.revoke(payload as never);
        } catch (err) {
          throw wrapErr("developer_marketplace_oauth_revoke", err);
        }
      },
    },
    {
      name: "developer_marketplace_audit_logs_list",
      description: "List developer marketplace audit logs, optionally filtered by app id.",
      schema: z.object({ app_id: z.string().optional() }),
      handler: async ({ app_id }) => {
        try {
          return await client.developerMarketplace.listAuditLogs(app_id);
        } catch (err) {
          throw wrapErr("developer_marketplace_audit_logs_list", err);
        }
      },
    },
  ];
}

function cleanObject<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

function wrapErr(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
