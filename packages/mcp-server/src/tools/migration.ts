// SPDX-License-Identifier: MIT
import { z } from "zod";
import { CUTOVER_EVIDENCE_KEYS, type PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

const SourceEnum = z.enum([
  "mailchimp",
  "activecampaign",
  "klaviyo",
  "customerio",
  "hubspot",
  "convertkit",
  "brevo",
  "substack",
  "beehiiv",
  "mailerlite",
  "sendy",
  "csv",
]);
const OAuthSourceEnum = z.enum(["mailchimp", "convertkit"]);
const CredentialSourceEnum = z.enum([
  "activecampaign",
  "klaviyo",
  "customerio",
  "hubspot",
  "beehiiv",
  "brevo",
  "mailerlite",
]);
const SourceEventSourceEnum = z.enum(["activecampaign", "hubspot", "klaviyo"]);
const MigrationJobId = z.string().trim().min(1).max(200);
const CustomerIOWorkspaceIDPattern = /^\d{1,64}$/u;
const CustomerIOWorkspaceIDMessage =
  "Customer.io workspace ID must be numeric and contain 1 to 64 digits";
const HubSpotHubIDPattern = /^\d{1,64}$/u;
const HubSpotHubIDMessage =
  "HubSpot hub ID must be numeric and contain 1 to 64 digits";
const MailchimpAudienceID = z.string().trim().min(1).max(200);
const MigrationSecret = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .describe(
    "Sensitive source credential. Never echo, log, or include it in evidence; it is sent only to the encrypted job-scoped source session endpoint.",
  );
const ExplicitApproval = z
  .literal(true)
  .describe(
    "Must be true only after the human user explicitly approves this state-changing action.",
  );
const ShadowIntervalSeconds = z
  .number()
  .int()
  .min(300)
  .max(604_800)
  .default(3_600)
  .describe("Polling interval in seconds, from 5 minutes through 7 days.");
const AutomationRebuildStatusEnum = z.enum([
  "not_started",
  "rebuilding",
  "test_passed",
  "approved_not_needed",
  "blocked",
]);
const CutoverEvidenceSourceEnum = z.enum([
  "activecampaign",
  "beehiiv",
  "hubspot",
  "klaviyo",
  "customerio",
]);
const CutoverEvidenceKeyEnum = z.enum(CUTOVER_EVIDENCE_KEYS);
const CutoverEvidenceStatusEnum = z.enum(["pass", "warning", "blocker"]);
const ADMIN_SCOPE = ["admin"];

const readOnlyExternalAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};
const mutatingExternalAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const evidenceMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

function requireMailchimpAudienceScope(
  source: string,
  selectedAudienceIds: readonly string[] | undefined,
  operation: "dry-run" | "commit",
): readonly string[] | undefined {
  if (
    source === "mailchimp" &&
    (!selectedAudienceIds || selectedAudienceIds.length === 0)
  ) {
    throw new Error(
      `Mailchimp ${operation} requires at least one selected audience ID`,
    );
  }
  return selectedAudienceIds;
}

async function requireMigrationSourceBinding(
  client: PostwaveClient,
  source: string,
  jobId: string,
): Promise<void> {
  const job = await client.migrations.get(jobId);
  if (job.source !== source) {
    throw new Error(
      `Migration job source ${JSON.stringify(job.source)} does not match requested source ${JSON.stringify(source)}`,
    );
  }
}

function requireAutomationRebuildEvidence(
  status: string,
  testEvidence: string | undefined,
): void {
  if (
    (status === "test_passed" || status === "approved_not_needed") &&
    !testEvidence?.trim()
  ) {
    throw new Error(
      "Automation rebuild pass or waiver requires non-secret test_evidence",
    );
  }
}

function requireCutoverEvidenceKeyForSource(
  source: "activecampaign" | "beehiiv" | "hubspot" | "klaviyo" | "customerio",
  key: (typeof CUTOVER_EVIDENCE_KEYS)[number],
): void {
  const sourceSpecific = key.startsWith(`${source}_`);
  const shared =
    key === "source_discovery_warnings" ||
    key === "source_archive_warnings" ||
    (source === "activecampaign" && key === "sms_readiness");
  if (!sourceSpecific && !shared) {
    throw new Error(
      `Cutover evidence key ${JSON.stringify(key)} is not valid for ${source}`,
    );
  }
}

export function migrationTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "migrate_start",
      description:
        "Begin OAuth authorization for an OAuth-capable migration source. Returns an authorize_url the human must open plus a state token. For a Mailchimp reconnect, pass the existing callback job ID as job_id so authorization is rebound to the same migration rather than creating a replacement job. Use this before migrate_discover.",
      schema: z.object({
        source: OAuthSourceEnum.describe(
          "OAuth source platform to authorize. Credential-based sources use migrate_credentials.",
        ),
        job_id: MigrationJobId.optional().describe(
          "Existing callback job ID for a same-job OAuth reconnect. Omit when starting a new migration.",
        ),
      }),
      timeoutMs: 60_000,
      handler: async ({ source, job_id }) =>
        job_id
          ? client.migrations.start(source, job_id)
          : client.migrations.start(source),
    },
    {
      name: "migrate_credentials",
      description:
        "Create a same-tenant migration job for a credential-based source. HubSpot uses a dedicated private-app token with contacts, contact-schema, lists, subscription-definition, subscription-status, account-details, and private-app API-usage reads; Enterprise-only batch subscription scopes are not required because the adapter uses per-contact 2026-03 reads. An optional numeric Hub ID is provider-verified, the response is redacted, and reconnects must preserve the portal binding. Customer.io requires an App API key (never a Track API site key), an explicit us/eu region, and a numeric workspace ID when the key exposes multiple workspaces; the resulting lineage is bound to that exact region/workspace. This MCP tool exposes only Klaviyo's private API key path and accepts an optional explicit account ID; caller-managed Klaviyo bearer handoff is available only through the direct API/SDK and is not a Moosewave-managed migration OAuth flow. An unrolled-back tenant/account lineage must reuse its original Klaviyo migration job for credential refreshes and delta/full snapshots; a second job for the same tenant/account is rejected. Customer.io likewise reuses its original job, and a second job for the same tenant/workspace is rejected. Beehiiv requires the API key plus an explicit publication ID and is bound to that exact workspace/publication. The credential is stored only in the encrypted job-scoped source session. Use the returned job_id with migrate_discover and migrate_dry_run.",
      schema: z.object({
        source: CredentialSourceEnum,
        api_key: z.string().trim().min(1).max(2_000),
        account_id: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .refine((value) => !/^\d{65,}$/u.test(value), {
            message: CustomerIOWorkspaceIDMessage,
          })
          .optional()
          .describe(
            "Beehiiv publication ID (required for Beehiiv), ActiveCampaign account API URL, optional Klaviyo account ID, numeric Customer.io workspace ID, or optional HubSpot hub ID.",
          ),
        region: z
          .enum(["us", "eu"])
          .default("us")
          .describe("Customer.io App API region; ignored by other sources."),
      }),
      timeoutMs: 60_000,
      handler: async ({ source, api_key, account_id, region }) => {
        if (source === "beehiiv" && !account_id) {
          throw new Error(
            "Beehiiv credential handoff requires an explicit publication ID",
          );
        }
        if (source === "beehiiv" && !account_id?.startsWith("pub_")) {
          throw new Error(
            "Beehiiv publication ID must use the documented pub_ prefix",
          );
        }
        if (
          source === "customerio" &&
          account_id &&
          !CustomerIOWorkspaceIDPattern.test(account_id)
        ) {
          throw new Error(CustomerIOWorkspaceIDMessage);
        }
        if (
          source === "hubspot" &&
          account_id &&
          !HubSpotHubIDPattern.test(account_id)
        ) {
          throw new Error(HubSpotHubIDMessage);
        }
        const extra: Record<string, string> | undefined =
          source === "beehiiv" && account_id
            ? { publication_id: account_id }
            : source === "activecampaign" && account_id
              ? { api_url: account_id }
              : source === "hubspot" && account_id
                ? { hub_id: account_id }
                : source === "customerio"
                  ? { region: region ?? "us" }
                  : undefined;
        return client.migrations.credentials(source, {
          api_key,
          ...(account_id ? { account_id } : {}),
          ...(extra ? { extra } : {}),
        });
      },
    },
    {
      name: "migrate_discover",
      description:
        'Pre-flight inventory of the source account: subscribers, lists, segments, automation inventory, archive size, and provider review surfaces. For Mailchimp, first discover audiences, then optionally repeat discovery with selected_audience_ids for an informative scoped inventory; migrate_dry_run reruns discovery and persists the authoritative reviewed scope. Mailchimp cannot enumerate Customer Journeys: its one generic non-detected gap is not inventory, so operators must attach a manual rebuild/waiver checklist. ActiveCampaign automation inventory is rebuild-review evidence, not executable flow creation. HubSpot discovery is an exact 2026-03 snapshot of email-addressable contacts, excluded non-email contacts, additional email identities, non-sensitive property definitions/populated values, list membership plus allowlisted structural list metadata, active subscription definitions, and per-contact plus wide email preferences. HubSpot filter predicates are deliberately not requested or persisted because their operations can contain sensitive property and integration-event literals; inspect and rebuild, retain, or retire those rules in HubSpot. HubSpot segments_count combines exact list snapshots with one targeting boundary per active email subscription definition; it is not a lists-only count, while subscription_channels_count separately reports active definitions. Enabled requires every active email definition SUBSCRIBED, no scoped/wide opt-out, and no current-primary-email hard-bounce, quarantine, invalid-address, non-marketing/unknown-marketing-contact, pending/unconfirmed double-opt-in, or legacy-opt-out restriction. Consent timestamps require defensible evidence on every active subscribed row. This is conservative import eligibility, not exact HubSpot sendability parity; a primary-email change requires a fresh full snapshot. Eleven unconditional HubSpot unsupported/rule-boundary rows include dynamic-list rules and ten unsupported product areas; each source_total=1 is one non-additive checklist, never proof of presence or absence. Three additional exact identity/property rows carry real provider counts, for 14 scope-review rows total. HubSpot fails closed above 1,000,000 contacts, 10,000 traversal pages, 64 MiB retained snapshot data, a 10,000-result changed-contact search window, or a daily API budget that cannot cover one usage probe, two preference reads per email-addressable contact, and max(1,000 calls, 5% of the daily limit) reserve. Customer.io discovery is bound to one US/EU workspace; it inventories email-addressable immutable cio_id profiles, profiles without email, duplicate-email identities, subscription-center topic/channel definitions and preferences, ESP suppressions, frozen segment memberships, sent email one-time sends, rebuild-only automations, sender-specific SMS/WhatsApp /v1/optouts, non-email and transactional/API-broadcast evidence, and manual ecosystem dependencies. Customer.io email is enabled only when global subscribed + resolved email-channel subscribed/default + applicable topic subscribed/default; /v1/optouts is separate non-email evidence and never determines email eligibility. Sent-newsletter history requires at least one explicit language="" content; the lowest stable ID represents a multi-default/A-B set with an explicit warning, all variants remain evidence, missing defaults/invalid language fail closed, and translations are never silently selected. Newsletter and Design Studio HTML are exact source content/composition, not provider-rendered output. It never treats GET /customers as a global list, activates an automation, or claims an incremental profile-change feed. Beehiiv discovery inventories frozen segment/list snapshots, rebuild-only automations, eligible sent posts, and premium metadata; it does not promise Stripe billing continuity. Klaviyo discovery inventories the primary email identity and available consent/suppression state exposed by stable Get Profiles, the exact enumerated send-targetable list/segment projection after validated list-level suppressions are excluded, flow rebuild records, editable templates, sent email campaign archive rows, separate sent SMS/push source-archive evidence, and a mandatory multi-email manual-review record. The adapter does not expose a separate raw Klaviyo membership count. Profile reads request predictive_analytics and are throttled to its stricter 10 requests/second and 150 requests/minute tier. Provider list/segment names are nullable; unnamed records receive deterministic `Klaviyo list <id>` and `Klaviyo segment <id>` names. Stable Get Profiles does not expose secondary email identifiers or their independent per-address consent/suppression state, so discovery cannot prove profile-identity or consent parity. Draft campaign-message definitions and flow definitions may be null and remain explicitly incomplete rebuild evidence; campaign tag relationships retain provider IDs only, not resolved names. Eight static product-area source-archive rows are emitted unconditionally as checklists: source_total=1 means one checklist record, not detected source inventory. SMS/push records never materialize as email campaigns, and discovery does not promise executable flows, dynamic predicates, reports, or non-email-only profile runtime.',
      schema: z.object({
        source: SourceEnum,
        session_id: MigrationJobId.describe(
          "Job ID supplied by the OAuth callback after authorization, or returned by credential/file handoff. This is not the OAuth state token.",
        ),
        selected_audience_ids: z
          .array(MailchimpAudienceID)
          .min(1)
          .max(1_000)
          .optional()
          .describe(
            "Optional Mailchimp audience IDs for an informative scoped inventory. The IDs passed to migrate_dry_run become the authoritative reviewed scope.",
          ),
      }),
      timeoutMs: 60_000,
      handler: async ({ source, session_id, selected_audience_ids }) =>
        client.migrations.discover(source, session_id, selected_audience_ids),
    },
    {
      name: "migrate_dry_run",
      description:
        "Start an asynchronous verification run without destination writes. The run reruns source discovery; for Mailchimp, selected_audience_ids is required and becomes the authoritative scope persisted on the job, regardless of any earlier scoped discovery. Poll migrate_status until awaiting_confirmation or failed, then review selected_audience_ids and verification_report. Only the validated Classic welcome-series subset is runtime-capable. Mailchimp's generic non-detected Customer Journey gap is not inventory; attach a manual Journey rebuild/waiver checklist. The report also preserves ActiveCampaign automation rebuild-review evidence; HubSpot exact identity/property/preference inventory, conservative current-primary-email eligibility coverage, frozen list/subscription tags, 14-row CRM-bridge scope review, and final-snapshot readiness; Customer.io immutable cio_id identity/audience/archive evidence plus the fail-closed global/email-channel/topic email projection, separate sender-specific SMS/WhatsApp opt-out evidence, explicit empty-language/lowest-stable-A-B newsletter selection, raw variants, source-only HTML composition, and exact-source Design Studio fidelity warnings, with automations and non-email channels kept non-executable; Beehiiv frozen snapshots and explicit no-Stripe-billing boundary; and Klaviyo suppression-filtered send-targetable audience snapshots, nullable flow/draft-message rebuild records, IDs-only campaign tags, sent email campaign archive rows, separate non-executable SMS/push source-archive evidence, a mandatory secondary-email/per-address-consent review record, eight unconditional static checklist rows that are not inventory, and explicit runtime exclusions. A dry-run is not cutover certification.",
      schema: z.object({
        source: SourceEnum,
        session_id: MigrationJobId,
        selected_audience_ids: z
          .array(MailchimpAudienceID)
          .min(1)
          .max(1_000)
          .optional()
          .describe(
            "Required for Mailchimp. These IDs become the authoritative reviewed scope persisted by this dry-run; commit must repeat the same normalized set.",
          ),
      }),
      timeoutMs: 60_000,
      handler: async ({ source, session_id, selected_audience_ids }) =>
        client.migrations.dryRun(
          source,
          session_id,
          requireMailchimpAudienceScope(
            source,
            selected_audience_ids,
            "dry-run",
          ),
        ),
    },
    {
      name: "migrate_commit",
      description:
        "Start the asynchronous destination import only after a successful dry-run and explicit user approval. For Mailchimp, selected_audience_ids is required and the server rejects any set that differs from the authoritative normalized dry-run scope. Poll migrate_status until completed or failed; a conflict-aware rollback is available for tracked destination writes within 7 days. HubSpot's initial contact import is not cutover approval: retain changed-contact polling for at least seven continuous days, freeze contact/list/preference/primary-email changes, run the authoritative final full snapshot, reconcile preference plus current-email eligibility coverage, exact list/subscription membership and removals, complete the 14-row CRM-bridge scope review, then require clean shadow, rollback rehearsal, strict pilot acceptance, durable local-session cleanup, and external private-app-token cleanup evidence. Beehiiv's initial commit is never cutover approval: after it completes, finish rebuilds and billing handoff, freeze source edits, run a final delta import, a fresh shadow check, rollback rehearsal, strict pilot acceptance, and only then record post-delta cutover evidence. Klaviyo's initial commit is likewise never cutover approval; flow rebuilds, exact final profile/audience snapshot, source-event reconciliation, shadow, rollback, six provider reviews, and credential cleanup still gate cutover. Customer.io also requires a frozen full cio_id snapshot because no supported incremental profile-change feed exists; prove global subscribed + resolved email-channel subscribed/default + applicable topic subscribed/default, keep sender-specific SMS/WhatsApp /v1/optouts separate, and complete fresh shadow, rollback rehearsal, and six provider reviews.",
      schema: z.object({
        source: SourceEnum,
        session_id: MigrationJobId,
        selected_audience_ids: z
          .array(MailchimpAudienceID)
          .min(1)
          .max(1_000)
          .optional()
          .describe(
            "Required for Mailchimp. Must repeat the authoritative normalized audience set persisted by the reviewed dry-run.",
          ),
      }),
      timeoutMs: 60_000,
      handler: async ({ source, session_id, selected_audience_ids }) =>
        client.migrations.commit(
          source,
          session_id,
          requireMailchimpAudienceScope(
            source,
            selected_audience_ids,
            "commit",
          ),
        ),
    },
    {
      name: "migrate_status",
      description:
        "Poll a migration job by ID. Returns the raw job record, including id, source, status, progress, cursor, timestamps, rollback_until, selected_audience_ids, verification_report, and error. After dry-run, wait for awaiting_confirmation before review or commit.",
      schema: z.object({
        job_id: MigrationJobId,
      }),
      timeoutMs: 60_000,
      handler: async ({ job_id }) => client.migrations.get(job_id),
    },
    {
      name: "migrate_source_session_refresh",
      description:
        "Refresh the encrypted source session on the same migration job when its credential expires; this never creates a replacement job. The supplied source is checked against the stored job before any credential is sent. Preserve the original account/publication binding: Beehiiv must use the same pub_ publication, ActiveCampaign the same account API URL, HubSpot the same portal, Klaviyo the same account ID, and Customer.io the same numeric workspace plus us/eu region when supplied. OAuth sources should normally use migrate_start with the existing job_id. Requires admin scope and explicit user approval; credentials are never returned or included in evidence.",
      schema: z.object({
        source: SourceEnum,
        job_id: MigrationJobId.describe(
          "Existing migration job whose stored source binding must match source.",
        ),
        api_key: MigrationSecret.optional(),
        access_token: MigrationSecret.optional(),
        refresh_token: MigrationSecret.optional(),
        account_id: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .refine((value) => !/^\d{65,}$/u.test(value), {
            message: CustomerIOWorkspaceIDMessage,
          })
          .optional()
          .describe(
            "Original ActiveCampaign API URL, HubSpot hub ID, Beehiiv pub_ publication ID, Klaviyo account ID, or Customer.io workspace ID; never use an unrelated account.",
          ),
        region: z
          .enum(["us", "eu"])
          .optional()
          .describe(
            "Original Customer.io App API region. Omit to reuse the job binding; ignored by other sources.",
          ),
        confirm: ExplicitApproval,
      }),
      timeoutMs: 60_000,
      requiredScopes: ADMIN_SCOPE,
      annotations: mutatingExternalAnnotations,
      handler: async ({
        source,
        job_id,
        api_key,
        access_token,
        refresh_token,
        account_id,
        region,
      }) => {
        if (!api_key && !access_token && !refresh_token) {
          throw new Error(
            "A source credential is required to refresh the session",
          );
        }
        if (
          source === "beehiiv" &&
          account_id !== undefined &&
          !account_id.startsWith("pub_")
        ) {
          throw new Error(
            "Beehiiv publication ID must use the documented pub_ prefix",
          );
        }
        if (
          source === "customerio" &&
          account_id &&
          !CustomerIOWorkspaceIDPattern.test(account_id)
        ) {
          throw new Error(CustomerIOWorkspaceIDMessage);
        }
        if (
          source === "hubspot" &&
          account_id &&
          !HubSpotHubIDPattern.test(account_id)
        ) {
          throw new Error(HubSpotHubIDMessage);
        }
        await requireMigrationSourceBinding(client, source, job_id);
        const extra: Record<string, string> | undefined =
          source === "beehiiv" && account_id
            ? { publication_id: account_id }
            : source === "activecampaign" && account_id
              ? { api_url: account_id }
              : source === "hubspot" && account_id
                ? { hub_id: account_id }
                : source === "customerio" && region
                  ? { region }
                  : undefined;
        return client.migrations.refreshSourceSession(job_id, {
          ...(api_key ? { api_key } : {}),
          ...(access_token ? { access_token } : {}),
          ...(refresh_token ? { refresh_token } : {}),
          ...(account_id ? { account_id } : {}),
          ...(extra ? { extra } : {}),
        });
      },
    },
    {
      name: "migrate_verification",
      description:
        "Read the authoritative verification report for a committed or final-delta migration job after checking that source and job_id still match. Review exact counts, completeness rows, warnings, automation/flow rebuild inventory, and source-specific boundaries; this report alone is not cutover acceptance. For Beehiiv, the initial commit report does not prove cutover readiness and premium metadata does not prove Stripe billing continuity. For Klaviyo, audience counts/tags are the suppression-filtered send-targetable projection rather than raw membership; only sent email materializes as email campaign archive rows; SMS/push remains non-executable source-archive evidence; nullable flow/draft-message definitions are incomplete rebuild records; and campaign tags are IDs only. Stable Get Profiles omits secondary email identifiers and independent per-address consent/suppression, so the preserved multi-email review record must be reconciled manually. The eight static product-area rows are unconditional checklists, not detected inventory, and the report cannot prove complete profile identity/consent, dynamic-rule, executable-flow, non-email identity, reporting, or ecosystem continuity.",
      schema: z.object({
        source: SourceEnum,
        job_id: MigrationJobId.describe(
          "Migration job whose stored source binding must match source.",
        ),
      }),
      timeoutMs: 60_000,
      annotations: readOnlyExternalAnnotations,
      handler: async ({ source, job_id }) => {
        await requireMigrationSourceBinding(client, source, job_id);
        return client.migrations.verification(job_id);
      },
    },
    {
      name: "migrate_delta_import",
      description:
        "Run the required final delta import on an already completed initial commit after the operator freezes source edits. This writes destination data and resets the job to an asynchronous import; poll migrate_status back to completed, then obtain a fresh verification report and shadow check. Record cutover evidence only after this latest delta succeeds. For HubSpot this is an idempotent full contact/list/preference/eligibility snapshot and is authoritative for current-primary-email identity and fields/status, hard removals, loss/change of email, exact list/subscription membership, and conservative current-email eligibility; changed-contact polling cannot prove standalone list/preference changes or deletions. Customer.io has no supported incremental profile-change feed, so its final delta is a full email-addressable cio_id snapshot that must reconcile duplicate-email ownership, email moves/deletions, fields, global + resolved email-channel + applicable-topic status including defaults, ESP suppressions, separate sender-specific SMS/WhatsApp /v1/optouts, and exact frozen memberships. Beehiiv has no continuous source-event bridge, so its initial commit is not cutover: a frozen-source final full delta is mandatory. Klaviyo also requires a final full profile/list/segment snapshot because changed-profile replay cannot prove deletions, lost-email profiles, consent/suppression authority, or exact audience membership; even that snapshot cannot expose secondary email identities or independent per-address consent through stable Get Profiles, so manual reconciliation remains mandatory. Klaviyo incremental replay fails closed when a stable profile ID changes email from A to B while its prior source-owned A destination remains active; this full snapshot must materialize B and disable A before replay resumes. Requires admin scope and explicit user approval.",
      schema: z.object({
        source: SourceEnum,
        job_id: MigrationJobId.describe(
          "Completed committed migration job whose stored source must match source.",
        ),
        confirm: ExplicitApproval,
      }),
      timeoutMs: 60_000,
      requiredScopes: ADMIN_SCOPE,
      annotations: mutatingExternalAnnotations,
      handler: async ({ source, job_id }) => {
        await requireMigrationSourceBinding(client, source, job_id);
        return client.migrations.deltaImport(source, job_id);
      },
    },
    {
      name: "migrate_shadow_check",
      description:
        "Rerun the complete source inventory for a completed migration and compare it with the latest full-snapshot fingerprint after validating the source/job binding. Use a fresh check after the final delta; any non-zero delta, same-count content change, blocker, incomplete pagination, or needs_delta_import result blocks cutover. For Customer.io, Beehiiv, and Klaviyo this post-delta check is required because the initial import has no cutover meaning. The check persists bounded operational history, so it requires admin scope.",
      schema: z.object({
        source: SourceEnum,
        job_id: MigrationJobId.describe(
          "Completed migration job whose stored source must match source.",
        ),
      }),
      timeoutMs: 60_000,
      requiredScopes: ADMIN_SCOPE,
      annotations: mutatingExternalAnnotations,
      handler: async ({ source, job_id }) => {
        await requireMigrationSourceBinding(client, source, job_id);
        return client.migrations.shadowCheck(source, job_id);
      },
    },
    {
      name: "migrate_shadow_monitor_start",
      description:
        "Start recurring source shadow checks for a completed migration during the controlled overlap window. The source/job binding is verified before the monitor is created and one check runs immediately. This creates background source traffic and persisted history; requires admin scope and explicit user approval. A monitor never replaces the frozen-source final delta, especially for Customer.io, Beehiiv, or Klaviyo, and must not be presented as cutover approval.",
      schema: z.object({
        source: SourceEnum,
        job_id: MigrationJobId.describe(
          "Completed migration job whose stored source must match source.",
        ),
        interval_seconds: ShadowIntervalSeconds,
        confirm: ExplicitApproval,
      }),
      timeoutMs: 60_000,
      requiredScopes: ADMIN_SCOPE,
      annotations: mutatingExternalAnnotations,
      handler: async ({ source, job_id, interval_seconds }) => {
        await requireMigrationSourceBinding(client, source, job_id);
        return client.migrations.startShadowMonitor(
          source,
          job_id,
          interval_seconds,
        );
      },
    },
    {
      name: "migrate_shadow_monitor_status",
      description:
        "Read the shadow monitor configuration and bounded recent check history after verifying the requested source matches the migration job. Inspect enabled, last_error, last_recommended_action, and every blocker; monitor status is operational evidence, not cutover acceptance, and does not replace the final delta.",
      schema: z.object({
        source: SourceEnum,
        job_id: MigrationJobId.describe(
          "Migration job whose stored source binding must match source.",
        ),
      }),
      timeoutMs: 60_000,
      annotations: readOnlyExternalAnnotations,
      handler: async ({ source, job_id }) => {
        await requireMigrationSourceBinding(client, source, job_id);
        return client.migrations.shadowMonitor(job_id);
      },
    },
    {
      name: "migrate_shadow_monitor_stop",
      description:
        "Disable a migration's recurring shadow monitor only after the overlap/cutover decision no longer needs it. The source/job binding is verified first. Stopping monitoring is destructive to future observation, does not certify cutover, and requires admin scope plus explicit user approval.",
      schema: z.object({
        source: SourceEnum,
        job_id: MigrationJobId.describe(
          "Migration job whose stored source binding must match source.",
        ),
        confirm: ExplicitApproval,
      }),
      timeoutMs: 60_000,
      requiredScopes: ADMIN_SCOPE,
      annotations: evidenceMutationAnnotations,
      handler: async ({ source, job_id }) => {
        await requireMigrationSourceBinding(client, source, job_id);
        return client.migrations.stopShadowMonitor(job_id);
      },
    },
    {
      name: "migrate_source_events_start",
      description:
        "Start incremental source-event polling for an ActiveCampaign, HubSpot, or Klaviyo migration job after verifying the source/job binding. Keep the same monitor active throughout the controlled overlap; HubSpot certification requires at least seven continuous days. HubSpot polling covers changed contacts only and cannot prove standalone list-membership changes or preference-only changes, hard deletions, or loss/change of an email address. One CRM Search window also fails closed at 10,000 results, so poll more frequently or narrow the window. A frozen final full snapshot remains authoritative for identity, fields/status, preferences/current-email eligibility, removals, and exact list/subscription tags. This creates background source traffic and persisted evidence, requires admin scope, and requires explicit user approval.",
      schema: z.object({
        source: SourceEventSourceEnum,
        job_id: MigrationJobId.describe(
          "Committed migration job whose stored source binding must match source.",
        ),
        interval_seconds: ShadowIntervalSeconds,
        confirm: ExplicitApproval,
      }),
      timeoutMs: 60_000,
      requiredScopes: ADMIN_SCOPE,
      annotations: mutatingExternalAnnotations,
      handler: async ({ source, job_id, interval_seconds }) => {
        await requireMigrationSourceBinding(client, source, job_id);
        return client.migrations.startSourceEvents(
          source,
          job_id,
          interval_seconds,
        );
      },
    },
    {
      name: "migrate_source_events_status",
      description:
        "Read the bound ActiveCampaign, HubSpot, or Klaviyo source-event monitor and recent durable replay evidence. Inspect enabled, continuity, last sync/error, failed events, and manual-review rows. For HubSpot this is changed-contact overlap evidence only; it never proves standalone list-membership or preference-only changes, hard deletions, lost/changed email addresses, current-email eligibility after an unobserved change, or cutover readiness.",
      schema: z.object({
        source: SourceEventSourceEnum,
        job_id: MigrationJobId.describe(
          "Migration job whose stored source binding must match source.",
        ),
      }),
      timeoutMs: 60_000,
      annotations: readOnlyExternalAnnotations,
      handler: async ({ source, job_id }) => {
        await requireMigrationSourceBinding(client, source, job_id);
        return client.migrations.sourceEvents(job_id);
      },
    },
    {
      name: "migrate_source_events_stop",
      description:
        "Disable incremental source-event polling only after the retained overlap, final full snapshot, clean shadow check, rollback rehearsal, strict pilot acceptance, and required scope/cleanup reviews are complete. The source/job binding is verified first. For authorized ActiveCampaign or HubSpot post-pilot cleanup, set post_pilot_cleanup=true only after the matching durable cleanup evidence gate passes. HubSpot then atomically claims cleanup start, disables replay, and deletes the local encrypted source session before rollback/external token cleanup; the response must report source_session_cleared=true. Stopping destroys future observation and does not itself certify cutover, so it requires admin scope and explicit user approval.",
      schema: z.object({
        source: SourceEventSourceEnum,
        job_id: MigrationJobId.describe(
          "Migration job whose stored source binding must match source.",
        ),
        post_pilot_cleanup: z
          .boolean()
          .default(false)
          .describe(
            "True only for durably authorized ActiveCampaign/HubSpot post-pilot cleanup. HubSpot also clears its local encrypted source session.",
          ),
        confirm: ExplicitApproval,
      }),
      timeoutMs: 60_000,
      requiredScopes: ADMIN_SCOPE,
      annotations: evidenceMutationAnnotations,
      handler: async ({ source, job_id, post_pilot_cleanup }) => {
        await requireMigrationSourceBinding(client, source, job_id);
        return client.migrations.stopSourceEvents(
          job_id,
          Boolean(post_pilot_cleanup),
        );
      },
    },
    {
      name: "migrate_automation_rebuild_list",
      description:
        "List the durable manual automation rebuild/test checklist after verifying source and job_id match. ActiveCampaign and Beehiiv automation definitions and Klaviyo flow definitions are review evidence, not executable Moosewave flows. Every item must be test_passed with non-secret evidence or explicitly approved_not_needed with waiver evidence before strict acceptance; an initial import never satisfies this gate by itself.",
      schema: z.object({
        source: SourceEnum,
        job_id: MigrationJobId.describe(
          "Migration job whose stored source binding must match source.",
        ),
      }),
      timeoutMs: 60_000,
      annotations: readOnlyExternalAnnotations,
      handler: async ({ source, job_id }) => {
        await requireMigrationSourceBinding(client, source, job_id);
        return client.migrations.automationRebuilds(job_id);
      },
    },
    {
      name: "migrate_automation_rebuild_update",
      description:
        "Update one durable automation rebuild/checklist item after verifying source and job_id match. A test_passed or approved_not_needed status requires a concrete non-secret test_evidence or waiver reference; never put credentials, tokens, subscriber data, or raw message content in evidence. This can overwrite reviewed evidence, so it requires admin scope and explicit user approval.",
      schema: z.object({
        source: SourceEnum,
        job_id: MigrationJobId.describe(
          "Migration job whose stored source binding must match source.",
        ),
        rank: z.number().int().min(1).max(10_000),
        name: z.string().trim().min(1).max(500),
        source_id: z.string().trim().min(1).max(500).optional(),
        status: AutomationRebuildStatusEnum,
        owner: z.string().trim().min(1).max(200).optional(),
        notes: z.string().trim().min(1).max(2_000).optional(),
        test_evidence: z
          .string()
          .trim()
          .min(1)
          .max(2_000)
          .optional()
          .describe(
            "Non-secret test result or waiver reference; required for test_passed and approved_not_needed.",
          ),
        confirm: ExplicitApproval,
      }),
      timeoutMs: 60_000,
      requiredScopes: ADMIN_SCOPE,
      annotations: evidenceMutationAnnotations,
      handler: async ({
        source,
        job_id,
        rank,
        name,
        source_id,
        status,
        owner,
        notes,
        test_evidence,
      }) => {
        requireAutomationRebuildEvidence(status, test_evidence);
        await requireMigrationSourceBinding(client, source, job_id);
        return client.migrations.updateAutomationRebuild(job_id, {
          rank,
          name,
          ...(source_id ? { source_id } : {}),
          status,
          ...(owner ? { owner } : {}),
          ...(notes ? { notes } : {}),
          ...(test_evidence ? { test_evidence } : {}),
        });
      },
    },
    {
      name: "migrate_rollback_rehearsal",
      description:
        "Generate and persist rollback-readiness evidence for the bound source/job without actually rolling back destination data. Run this after the latest successful final delta so acceptance cannot rely on stale counts. Because this GET-shaped endpoint mutates durable evidence, it requires admin scope and explicit user approval; migrate_rollback remains a separate destructive action.",
      schema: z.object({
        source: SourceEnum,
        job_id: MigrationJobId.describe(
          "Migration job whose stored source binding must match source.",
        ),
        confirm: ExplicitApproval,
      }),
      timeoutMs: 60_000,
      requiredScopes: ADMIN_SCOPE,
      annotations: evidenceMutationAnnotations,
      handler: async ({ source, job_id }) => {
        await requireMigrationSourceBinding(client, source, job_id);
        return client.migrations.rollbackRehearsal(job_id);
      },
    },
    {
      name: "migrate_pilot_acceptance",
      description:
        "Read strict pilot/cutover acceptance for the bound source/job. Call it only after the latest final delta completes, the fresh verification and shadow check are clean, source-event replay where supported, rebuilds and rollback rehearsal pass, and required cleanup/billing/ecosystem handoffs are evidenced. Treat warning or blocker as not ready. HubSpot additionally requires retained continuous changed-contact overlap, an authoritative final full contact/list/preference/eligibility snapshot, matching source fingerprint, complete per-contact preference and current-primary-email eligibility coverage, and a post-snapshot 14-row CRM-bridge scope review: three exact identity/property boundaries, one dynamic-rule boundary, and ten static unsupported-product checklists. A pass authorizes recording hubspot_post_pilot_cleanup; cleanup must then clear the local session before rollback and external token rotation/revocation. Beehiiv's initial commit is never sufficient and its preserved premium metadata is not Stripe billing continuity. Klaviyo also requires consent/suppression and profile-identity reconciliation, including the mandatory secondary-email/per-address-consent source-archive record and full-snapshot resolution of any fail-closed stable-profile email move, plus suppression-filtered audience snapshot, nullable-definition/IDs-only-tag review, flow rebuild, channel identity, deliverability, and ecosystem-dependency reviews. Its eight static product-area rows are checklists, not proof of inventory. Customer.io has no supported incremental profile-change feed: acceptance requires a final frozen full cio_id snapshot, duplicate-email/email-move/deletion reconciliation, exact frozen audience evidence, automation rebuilds, proof that global subscribed + resolved email-channel subscribed/default + applicable topic subscribed/default governs email with ESP suppression precedence, separate sender-specific SMS/WhatsApp /v1/optouts review, and newsletter/template fidelity review covering explicit empty-language defaults, warned lowest-stable-ID A/B representation, retained variants, source-only layout/body composition, and exact-source Design Studio HTML rather than provider rendering, plus deliverability/ecosystem reviews, fresh shadow, and rollback rehearsal.",
      schema: z.object({
        source: SourceEnum,
        job_id: MigrationJobId.describe(
          "Migration job whose stored source binding must match source.",
        ),
      }),
      timeoutMs: 60_000,
      annotations: readOnlyExternalAnnotations,
      handler: async ({ source, job_id }) => {
        await requireMigrationSourceBinding(client, source, job_id);
        return client.migrations.pilotAcceptance(job_id);
      },
    },
    {
      name: "migrate_cutover_evidence",
      description:
        "Record one reviewed ActiveCampaign, Beehiiv, HubSpot, Klaviyo, or Customer.io cutover-evidence gate for the bound source/job. HubSpot accepts hubspot_crm_bridge_scope_review for its 14 identity/property/rule/unsupported-surface rows and, only after strict pilot acceptance passes, hubspot_post_pilot_cleanup to freeze the evidence and authorize durable monitor/session cleanup. Never call this before the latest final delta/full snapshot completes successfully; passing evidence is tied to that snapshot and becomes stale after another import. Require a concrete human review note plus non-secret evidence references, never credentials or subscriber data. This can overwrite durable acceptance evidence and therefore requires admin scope and explicit user approval. It cannot turn an initial import into cutover readiness or waive missing parity, rebuild, identity/consent, replay where supported, or ecosystem review.",
      schema: z.object({
        source: CutoverEvidenceSourceEnum,
        job_id: MigrationJobId.describe(
          "Post-final-delta migration job whose stored source must match source.",
        ),
        key: CutoverEvidenceKeyEnum,
        status: CutoverEvidenceStatusEnum,
        detail: z
          .string()
          .trim()
          .min(1)
          .max(1_000)
          .describe("Human review note with no credentials or personal data."),
        evidence: z
          .array(
            z
              .string()
              .trim()
              .min(1)
              .max(500)
              .describe("Non-secret ticket, report, or test reference."),
          )
          .min(1)
          .max(50),
        confirm: ExplicitApproval,
      }),
      timeoutMs: 60_000,
      requiredScopes: ADMIN_SCOPE,
      annotations: evidenceMutationAnnotations,
      handler: async ({ source, job_id, key, status, detail, evidence }) => {
        requireCutoverEvidenceKeyForSource(source, key);
        await requireMigrationSourceBinding(client, source, job_id);
        return client.migrations.recordCutoverEvidence(job_id, {
          key,
          status,
          detail,
          evidence: evidence as [string, ...string[]],
        });
      },
    },
    {
      name: "migrate_rollback",
      description:
        "Start an asynchronous rollback of tracked destination writes within the 7-day window. Removes job-created records and restores recorded before-images only when doing so will not overwrite later edits or later-job ownership. Append-only consent and audit evidence remains with compensating rollback records. Poll migrate_rollback_status for progress.",
      schema: z.object({
        job_id: MigrationJobId,
      }),
      timeoutMs: 60_000,
      handler: async ({ job_id }) => client.migrations.rollback(job_id),
    },
    {
      name: "migrate_rollback_status",
      description:
        "Poll an asynchronous migration rollback. Returns state plus deleted and total counters for archives, templates, automations, segments, subscribers, lists, and paid subscriptions, with timestamps and an error when present.",
      schema: z.object({
        job_id: MigrationJobId.describe("Migration job being rolled back."),
      }),
      timeoutMs: 60_000,
      handler: async ({ job_id }) => client.migrations.rollbackStatus(job_id),
    },
  ];
}
