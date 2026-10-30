// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

const Id = z.string().min(1).max(256);
const IdempotencyKey = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "idempotency_key must not contain control characters",
  });
const StrongCampaignETag = z
  .string()
  .min(3)
  .max(512)
  .refine(
    (value) =>
      value === value.trim() &&
      new TextEncoder().encode(value).byteLength <= 512 &&
      value !== "*" &&
      !value.startsWith("W/") &&
      !value.includes(",") &&
      value.startsWith('"') &&
      value.endsWith('"') &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
    {
      message:
        "if_match must be the exact strong campaign ETag returned by the API",
    },
  );

/**
 * Campaign Assurance is deliberately separate from Inbox Reality: modeled
 * comprehension is a prediction over frozen MIME, not an observation of a
 * private provider UI.
 */
export function campaignAssuranceTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "campaign_assurance_run",
      description:
        "Start a durable, potentially billable Predicted Agent Comprehension run over an exact frozen campaign revision and send plan. This models comprehension; it does not observe Gmail, Gemini, or any recipient's inbox.",
      annotations: {
        title: "Run Campaign Assurance",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      requiredScopes: ["write:campaigns"],
      schema: z.object({
        campaign_id: Id,
        content_revision_id: Id,
        send_plan_id: Id,
        profile: z.enum(["fast", "full", "calibration"]).default("full"),
        request_id: z.string().uuid(),
        idempotency_key: IdempotencyKey,
      }),
      handler: async ({
        campaign_id,
        content_revision_id,
        send_plan_id,
        profile,
        request_id,
        idempotency_key,
      }) =>
        client.campaignAssurance.createRun(
          campaign_id,
          {
            profile,
            content_revision_id,
            send_plan_id,
            request_id,
          },
          { idempotencyKey: idempotency_key },
        ),
    },
    {
      name: "campaign_assurance_get",
      description:
        "Read the latest applicable Campaign Assurance receipt or one exact run view. Source classes and the Predicted Agent Comprehension disclosure are returned unchanged.",
      annotations: {
        title: "Get Campaign Assurance",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["read:campaigns"],
      schema: z.object({
        campaign_id: Id,
        run_id: Id.optional(),
        view: z
          .enum(["latest", "run", "manifest", "evidence", "events"])
          .default("latest"),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
      handler: async ({ campaign_id, run_id, view, limit, offset }) => {
        if (view === "latest") {
          if (run_id !== undefined) {
            throw new Error("run_id is not accepted when view is latest");
          }
          return client.campaignAssurance.getLatest(campaign_id);
        }
        if (!run_id) {
          throw new Error(`run_id is required when view is ${view}`);
        }
        switch (view) {
          case "run":
            return client.campaignAssurance.getRun(campaign_id, run_id);
          case "manifest":
            return client.campaignAssurance.getManifest(campaign_id, run_id);
          case "evidence":
            return client.campaignAssurance.getEvidence(campaign_id, run_id, {
              ...(limit === undefined ? {} : { limit }),
              ...(offset === undefined ? {} : { offset }),
            });
          case "events":
            return client.campaignAssurance.getEvents(campaign_id, run_id);
        }
      },
    },
    {
      name: "campaign_assurance_apply_fix",
      description:
        "Apply one server-stored deterministic Campaign Assurance patch only after explicit user approval. This advances the mutable campaign draft by creating a new immutable content revision, records an append-only application receipt, marks the originating run stale, and requires assurance to run again. The caller cannot submit patch instructions and must provide the exact strong campaign If-Match ETag they reviewed.",
      annotations: {
        title: "Apply Campaign Assurance Fix",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["write:campaigns"],
      schema: z
        .object({
          campaign_id: Id,
          run_id: Id,
          finding_id: Id,
          request_id: z.string().uuid(),
          idempotency_key: IdempotencyKey,
          if_match: StrongCampaignETag.describe(
            "Exact strong ETag for the campaign draft version the user reviewed.",
          ),
        })
        .strict(),
      handler: async ({
        campaign_id,
        run_id,
        finding_id,
        request_id,
        idempotency_key,
        if_match,
      }) =>
        client.campaignAssurance.applyFinding(
          campaign_id,
          run_id,
          finding_id,
          { request_id },
          { ifMatch: if_match, idempotencyKey: idempotency_key },
        ),
    },
    {
      name: "campaign_assurance_override",
      description:
        "Record an immutable owner/admin governed decision for one overridable finding. This does not fix content or change the certified artifact; allow_send requires a fresh matching finding and remains visible in the send receipt.",
      annotations: {
        title: "Override Campaign Assurance Finding",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["write:campaigns", "send:transactional"],
      schema: z.object({
        campaign_id: Id,
        run_id: Id,
        finding_id: Id,
        decision: z.enum(["allow_send", "reject"]),
        reason: z.string().min(10).max(2000),
        expires_at: z.string().datetime({ offset: true }).optional(),
        request_id: z.string().uuid(),
        idempotency_key: IdempotencyKey,
      }),
      handler: async ({
        campaign_id,
        run_id,
        finding_id,
        decision,
        reason,
        expires_at,
        request_id,
        idempotency_key,
      }) =>
        client.campaignAssurance.overrideFinding(
          campaign_id,
          run_id,
          finding_id,
          {
            request_id,
            decision,
            reason,
            ...(expires_at === undefined ? {} : { expires_at }),
          },
          { idempotencyKey: idempotency_key },
        ),
    },
    {
      name: "campaign_assurance_cancel",
      description:
        "Cancel one queued or running Campaign Assurance run. Completed evidence remains immutable; cancellation cannot erase an existing receipt.",
      annotations: {
        title: "Cancel Campaign Assurance Run",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["write:campaigns"],
      schema: z.object({
        campaign_id: Id,
        run_id: Id,
        idempotency_key: IdempotencyKey,
      }),
      handler: async ({ campaign_id, run_id, idempotency_key }) =>
        client.campaignAssurance.cancelRun(campaign_id, run_id, {
          idempotencyKey: idempotency_key,
        }),
    },
  ];
}
