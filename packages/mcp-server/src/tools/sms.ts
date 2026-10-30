// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

const SmsProviderEnum = z.enum(["twilio", "telnyx", "bandwidth"]);
const SmsCountryEnum = z.enum(["US", "CA"]);
const SmsSenderTypeEnum = z.enum(["10dlc", "toll_free", "short_code"]);
const SmsRegistrationStatusEnum = z.enum(["not_started", "draft"]);
const SmsCampaignStatusEnum = z.enum(["draft", "paused"]);
const SmsReportExportStatusEnum = z.enum([
  "all",
  "blocked",
  "failed",
  "problems",
  "undelivered",
]);
const SmsSuppressionReasonEnum = z.enum([
  "manual",
  "stop_keyword",
  "help_keyword",
  "carrier_block",
  "complaint",
  "quiet_hours",
  "expired",
]);
const SmsSuppressionPhone = z
  .string()
  .regex(/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u);
const SmsSuppressionCursor = z
  .string()
  .max(4096)
  .regex(/^v1\.[A-Za-z0-9_-]+$/u, "invalid SMS suppression cursor");
const CanonicalTenantUuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  );
const SuppressionUuidV4 = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );

const SenderInputSchema = z.object({
  provider: SmsProviderEnum.optional(),
  country: SmsCountryEnum.optional(),
  sender_type: SmsSenderTypeEnum.optional(),
  phone_number: z.string().min(1).optional(),
  messaging_service_sid: z.string().min(1).optional(),
  registration_status: SmsRegistrationStatusEnum.optional(),
  capabilities: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const SmsListInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  keyword: z.string().optional(),
  sender_profile_id: z.string().min(1).optional(),
});

const ConsentInputSchema = z
  .object({
    list_id: z.string().uuid().optional(),
    phone_e164: z.string().regex(/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/),
    action: z.literal("revoked"),
    source: z.literal("manual"),
    proof_text: z.string().trim().min(1).max(500),
  })
  .strict();

const CampaignInputSchema = z.object({
  sender_profile_id: z.string().min(1).optional(),
  list_id: z.string().min(1).optional(),
  name: z.string().min(1),
  body: z.string().min(1),
  media_url: z.string().url().optional(),
  status: SmsCampaignStatusEnum.optional(),
  scheduled_at: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const BroadcastInputSchema = z.object({
  limit: z.number().int().min(1).max(1000000).optional(),
  link_tracking: z.boolean().optional(),
});

const TestSendInputSchema = z.object({
  sender_profile_id: z.string().min(1),
  list_id: z.string().min(1),
  to: z.string().min(1),
  body: z.string().min(1),
  media_url: z.string().url().optional(),
  campaign_id: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export function smsTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "sms_setup",
      description:
        "Read partial first-party SMS setup status, including sender profiles, can_send, and blocking reasons.",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.sms.setup();
        } catch (err) {
          throw wrapErr("sms_setup", err);
        }
      },
    },
    {
      name: "sms_compliance",
      description:
        "Audit first-party SMS compliance gates for consent, registration, provider callback verification, and send readiness.",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.sms.compliance();
        } catch (err) {
          throw wrapErr("sms_compliance", err);
        }
      },
    },
    {
      name: "sms_pilot_readiness",
      description:
        "Check whether SMS pilot traffic is safe to enable and return pass/warning/blocker evidence.",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.sms.pilotReadiness();
        } catch (err) {
          throw wrapErr("sms_pilot_readiness", err);
        }
      },
    },
    {
      name: "sms_sender_list",
      description:
        "List first-party SMS sender profiles for Twilio, Telnyx, or Bandwidth. Provider app/profile setup remains operator-owned.",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.sms.listSenders();
        } catch (err) {
          throw wrapErr("sms_sender_list", err);
        }
      },
    },
    {
      name: "sms_sender_upsert",
      description:
        "Create or update a first-party SMS sender profile. Hosted mode has no configured or accepted process-global provider credentials. Provider effects and callbacks remain release-held until a tenant-bound encrypted credential vault and provider-account ownership resolver exists; this does not create provider messaging services, profiles, applications, or phone-number campaign assignments.",
      schema: SenderInputSchema,
      handler: async (input) => {
        if (Object.keys(input).length === 0) {
          throw new Error("sms_sender_upsert: pass at least one sender field");
        }
        try {
          return await client.sms.upsertSender(input);
        } catch (err) {
          throw wrapErr("sms_sender_upsert", err);
        }
      },
    },
    {
      name: "sms_sender_pause",
      description:
        "Pause an SMS sender profile, optionally recording the operator reason.",
      schema: z.object({
        sender_id: z.string().min(1),
        reason: z.string().optional(),
      }),
      handler: async ({ sender_id, reason }) => {
        try {
          return await client.sms.pauseSender(sender_id, reason);
        } catch (err) {
          throw wrapErr("sms_sender_pause", err);
        }
      },
    },
    {
      name: "sms_sender_resume",
      description: "Resume a paused SMS sender profile.",
      schema: z.object({ sender_id: z.string().min(1) }),
      handler: async ({ sender_id }) => {
        try {
          return await client.sms.resumeSender(sender_id);
        } catch (err) {
          throw wrapErr("sms_sender_resume", err);
        }
      },
    },
    {
      name: "sms_sender_pilot_certification",
      description:
        "Export pilot-certification evidence for a sender profile, including readiness items and provider callback/status URLs.",
      schema: z.object({ sender_id: z.string().min(1) }),
      handler: async ({ sender_id }) => {
        try {
          return await client.sms.senderPilotCertification(sender_id);
        } catch (err) {
          throw wrapErr("sms_sender_pilot_certification", err);
        }
      },
    },
    {
      name: "sms_a2p_brand_submit",
      description:
        "Release-held: A2P brand submission is unavailable until durable provider idempotency, reconciliation, and minimized receipts are deployed.",
      schema: z.object({
        sender_id: z.string().min(1),
        payload: z.record(z.unknown()),
      }),
      handler: async () => {
        throw releaseHeldError("sms_a2p_registration_release_held");
      },
    },
    {
      name: "sms_a2p_campaign_submit",
      description:
        "Release-held: A2P campaign submission is unavailable until durable provider idempotency, reconciliation, and minimized receipts are deployed.",
      schema: z.object({
        sender_id: z.string().min(1),
        payload: z.record(z.unknown()),
      }),
      handler: async () => {
        throw releaseHeldError("sms_a2p_registration_release_held");
      },
    },
    {
      name: "sms_a2p_poll",
      description:
        "Release-held: A2P polling is unavailable while provider responses can contain unbounded sensitive raw data.",
      schema: z.object({ sender_id: z.string().min(1) }),
      handler: async () => {
        throw releaseHeldError("sms_a2p_registration_release_held");
      },
    },
    {
      name: "sms_list_list",
      description: "List SMS audience lists.",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.sms.listLists();
        } catch (err) {
          throw wrapErr("sms_list_list", err);
        }
      },
    },
    {
      name: "sms_list_create",
      description:
        "Create an SMS audience list with optional opt-in keyword and default sender profile.",
      schema: SmsListInputSchema,
      handler: async (input) => {
        try {
          return await client.sms.createList(cleanObject(input));
        } catch (err) {
          throw wrapErr("sms_list_create", err);
        }
      },
    },
    {
      name: "sms_consent_record",
      description:
        "Record only a conservative operator SMS revocation. This cannot grant/import consent, clear carrier STOP, or manufacture provider evidence.",
      schema: ConsentInputSchema,
      handler: async (input) => {
        try {
          return await client.sms.recordConsent(cleanObject(input));
        } catch (err) {
          throw wrapErr("sms_consent_record", err);
        }
      },
    },
    {
      name: "sms_suppression_list",
      description:
        "Exact-admin read of one tenant-bound SMS suppression page at a response cutoff. Exact phone filtering uses a JSON body, never a URL. The tool never silently follows the opaque nextCursor or claims complete/current history; pass the returned cursor explicitly to continue.",
      schema: z
        .object({
          tenant_id: CanonicalTenantUuid,
          reason: SmsSuppressionReasonEnum.optional(),
          phone: SmsSuppressionPhone.optional(),
          cursor: SmsSuppressionCursor.optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.phone !== undefined && value.cursor !== undefined) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Exact phone lookup cannot continue a cursor",
              path: ["cursor"],
            });
          }
          if (value.phone !== undefined && value.limit !== undefined) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Exact phone lookup does not accept a limit",
              path: ["limit"],
            });
          }
        }),
      requiredScopes: ["admin"],
      annotations: {
        title: "List SMS suppressions",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async ({ tenant_id, ...input }) => {
        try {
          return await client.sms.listSuppressions({
            ...cleanObject(input),
            ...(tenant_id ? { tenantId: tenant_id } : {}),
          });
        } catch (err) {
          throw wrapErr("sms_suppression_list", err);
        }
      },
    },
    {
      name: "sms_suppression_add",
      description:
        "Exact-admin add or reassert of one reversible manual/manual workspace hold. It cannot mint carrier/system authority, grant consent, or make texting lawful. A later same-provider START restores only a provably preserved manual hold; historical or cross-authority ambiguity remains review-held.",
      schema: z.object({ phone: SmsSuppressionPhone }).strict(),
      requiredScopes: ["admin"],
      annotations: {
        title: "Add manual SMS hold",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async ({ phone }) => {
        try {
          return await client.sms.addSuppression({ phone, reason: "manual" });
        } catch (err) {
          throw wrapErr("sms_suppression_add", err);
        }
      },
    },
    {
      name: "sms_suppression_remove",
      description:
        "Exact-admin removal of one reversible manual/manual workspace hold after explicit confirmation. Locked provider, STOP, carrier, complaint, imported, API, and system authority remains fail-closed. Success does not restore consent or make texting lawful.",
      schema: z
        .object({
          suppression_id: SuppressionUuidV4,
          tenant_id: CanonicalTenantUuid,
          confirm_manual_hold_removal: z.literal(true),
        })
        .strict(),
      requiredScopes: ["admin"],
      annotations: {
        title: "Remove manual SMS hold",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      handler: async ({ suppression_id, tenant_id }) => {
        try {
          return await client.sms.removeSuppression(suppression_id, tenant_id);
        } catch (err) {
          throw wrapErr("sms_suppression_remove", err);
        }
      },
    },
    {
      name: "sms_campaign_list",
      description: "List first-party SMS campaigns.",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.sms.listCampaigns();
        } catch (err) {
          throw wrapErr("sms_campaign_list", err);
        }
      },
    },
    {
      name: "sms_campaign_get",
      description: "Get one first-party SMS campaign by id.",
      schema: z.object({ campaign_id: z.string().min(1) }),
      handler: async ({ campaign_id }) => {
        try {
          return await client.sms.getCampaign(campaign_id);
        } catch (err) {
          throw wrapErr("sms_campaign_get", err);
        }
      },
    },
    {
      name: "sms_campaign_create",
      description:
        "Create a draft or paused first-party SMS campaign. Scheduling and dispatch are release-held.",
      schema: CampaignInputSchema,
      handler: async (input) => {
        try {
          return await client.sms.createCampaign(cleanObject(input));
        } catch (err) {
          throw wrapErr("sms_campaign_create", err);
        }
      },
    },
    {
      name: "sms_campaign_report",
      description:
        "Release-held: the legacy campaign evidence report is unavailable until it has a bounded private fail-closed audit contract.",
      schema: z.object({ campaign_id: z.string().min(1) }),
      handler: async () => {
        throw releaseHeldError("sms_evidence_read_release_held");
      },
    },
    {
      name: "sms_campaign_report_export",
      description:
        "Release-held: recipient-level campaign export is unavailable until it has a bounded private fail-closed audit contract.",
      schema: z.object({
        campaign_id: z.string().min(1),
        status: SmsReportExportStatusEnum.optional(),
        limit: z.number().int().min(1).max(1000000).optional(),
      }),
      handler: async () => {
        throw releaseHeldError("sms_evidence_read_release_held");
      },
    },
    {
      name: "sms_campaign_send",
      description:
        "Release-held: SMS campaign dispatch has no durable budget/provider reconciliation lifecycle.",
      schema: z.object({
        campaign_id: z.string().min(1),
        options: BroadcastInputSchema.optional(),
      }),
      handler: async () => {
        throw releaseHeldError("sms_campaign_dispatch_release_held");
      },
    },
    {
      name: "sms_campaign_schedule",
      description: "Release-held: SMS campaign scheduling cannot imply a future send while dispatch is unavailable.",
      schema: z.object({
        campaign_id: z.string().min(1),
        scheduled_at: z.string().min(1),
      }),
      handler: async () => {
        throw releaseHeldError("sms_campaign_schedule_release_held");
      },
    },
    {
      name: "sms_campaign_pause",
      description: "Pause a scheduled or in-flight SMS campaign.",
      schema: z.object({ campaign_id: z.string().min(1) }),
      handler: async ({ campaign_id }) => {
        try {
          return await client.sms.pauseCampaign(campaign_id);
        } catch (err) {
          throw wrapErr("sms_campaign_pause", err);
        }
      },
    },
    {
      name: "sms_campaign_resume",
      description: "Release-held: resuming an SMS campaign cannot imply future dispatch while the worker lifecycle is unavailable.",
      schema: z.object({ campaign_id: z.string().min(1) }),
      handler: async () => {
        throw releaseHeldError("sms_campaign_resume_release_held");
      },
    },
    {
      name: "sms_campaign_cancel",
      description: "Cancel an SMS campaign before it reaches a terminal state.",
      schema: z.object({ campaign_id: z.string().min(1) }),
      handler: async ({ campaign_id }) => {
        try {
          return await client.sms.cancelCampaign(campaign_id);
        } catch (err) {
          throw wrapErr("sms_campaign_cancel", err);
        }
      },
    },
    {
      name: "sms_test_send",
      description:
        "Release-held: test sends have no durable budget/provider reconciliation lifecycle.",
      schema: TestSendInputSchema,
      handler: async () => {
        throw releaseHeldError("sms_test_dispatch_release_held");
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

function releaseHeldError(code: string): Error {
  return new Error(`SMS operation is structurally release-held (${code})`);
}
