import { describe, expect, it, vi } from "vitest";

import {
  CUTOVER_EVIDENCE_KEYS,
  PostwaveClient,
  type CutoverEvidenceInput,
} from "../src/index.js";
import {
  migrationJobPathSegment,
  migrationSourcePathSegment,
} from "../src/resources/migrations.js";
import type {
  DiscoveryReport,
  MigrationProgress,
  RollbackProgress,
  VerificationReport,
} from "../src/types.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("MigrationsResource path safety", () => {
  it("types current resource-completeness statuses from migration reports", () => {
    const report = {
      subscribers_imported: 0,
      suppression_list_size: 0,
      consent_known: 0,
      consent_unknown: 0,
      custom_fields_mapped: [],
      custom_fields_unmapped: [],
      segments_translated: 0,
      segments_with_warnings: [],
      automations_translated: 0,
      automations_unsupported: [],
      paid_subs_imported: 0,
      archive_imported: 0,
      source_archive_by_resource: {
        customerio_subscription_channel: 3,
      },
      resource_completeness: [
        {
          resource: "templates",
          label: "Templates and messages",
          source_total: 2,
          imported: 2,
          supported: true,
          status: "preserved_for_rebuild",
        },
        {
          resource: "automations",
          label: "Automations",
          source_total: 1,
          imported: 0,
          supported: true,
          status: "manual_rebuild_required",
        },
      ],
      data_loss_estimate_pct: 0,
    } satisfies VerificationReport;

    expect(report.resource_completeness.map((row) => row.status)).toEqual([
      "preserved_for_rebuild",
      "manual_rebuild_required",
    ]);
    expect(
      report.source_archive_by_resource.customerio_subscription_channel,
    ).toBe(3);
  });

  it("types the complete migration and rollback progress contracts", () => {
    const migration = {
      subscribers_total: 10,
      subscribers_done: 10,
      segments_total: 1,
      segments_done: 1,
      automations_total: 1,
      automations_done: 1,
      paid_subs_total: 0,
      paid_subs_done: 0,
      archive_total: 2,
      archive_done: 2,
      templates_total: 3,
      templates_done: 3,
    } satisfies MigrationProgress;
    const rollback = {
      state: "running",
      archive_deleted: 1,
      archive_total: 2,
      templates_deleted: 2,
      templates_total: 3,
      automations_deleted: 0,
      automations_total: 1,
      segments_deleted: 0,
      segments_total: 1,
      subscribers_deleted: 5,
      subscribers_total: 10,
      lists_deleted: 0,
      lists_total: 1,
      paid_subs_deleted: 0,
      paid_subs_total: 0,
      started_at: "2026-07-15T00:00:00Z",
    } satisfies RollbackProgress;

    expect(migration.templates_done).toBe(3);
    expect(rollback.subscribers_deleted).toBe(5);
  });

  it("types bounded Klaviyo discovery archive counts separately", () => {
    const discovery = {
      job_id: "job/klaviyo",
      source: "klaviyo",
      subscribers_count: 7,
      profiles_without_email_count: 3,
      segments_count: 2,
      automations_count: 1,
      paid_subs_count: 0,
      archive_count: 4,
      source_archive_count: 12,
      sms_campaigns_count: 2,
      push_campaigns_count: 1,
      audiences: [
        {
          id: "klaviyo:list:L_UNNAMED",
          name: "Klaviyo list L_UNNAMED",
          subscribers_total: 5,
        },
        {
          id: "klaviyo:segment:S_UNNAMED",
          name: "Klaviyo segment S_UNNAMED",
          subscribers_total: 2,
        },
      ],
      capabilities: {
        source: "klaviyo",
        auth_method: "api_key",
        supports: {
          subscribers: true,
          segments: true,
          automations: true,
          automation_mode: "rebuild_review",
          campaign_archive: true,
          paid_subs: false,
          consent_timestamps: true,
        },
      },
    } satisfies DiscoveryReport;

    expect(discovery.job_id).toBe("job/klaviyo");
    expect(discovery.archive_count).toBe(4);
    expect(discovery.sms_campaigns_count).toBe(2);
    expect(discovery.push_campaigns_count).toBe(1);
    expect(discovery.source_archive_count).toBe(12);
    expect(discovery.audiences?.map((audience) => audience.name)).toEqual([
      "Klaviyo list L_UNNAMED",
      "Klaviyo segment S_UNNAMED",
    ]);
  });

  it("types Customer.io object-type metadata separately from custom-object support", () => {
    const discovery = {
      job_id: "job/customerio",
      source: "customerio",
      subscribers_count: 7,
      segments_count: 2,
      automations_count: 1,
      paid_subs_count: 0,
      archive_count: 3,
      custom_objects_count: 4,
      subscription_channels_count: 3,
      capabilities: {
        source: "customerio",
        auth_method: "api_key",
        supports: {
          subscribers: true,
          segments: true,
          automations: true,
          automation_mode: "rebuild_review",
          campaign_archive: true,
          paid_subs: false,
          consent_timestamps: false,
          custom_objects: false,
        },
      },
    } satisfies DiscoveryReport;

    expect(discovery.custom_objects_count).toBe(4);
    expect(discovery.subscription_channels_count).toBe(3);
    expect(discovery.capabilities.supports.custom_objects).toBe(false);
  });

  it("types HubSpot additional email identities as non-sendable discovery evidence", () => {
    const discovery = {
      job_id: "job/hubspot",
      source: "hubspot",
      subscribers_count: 7,
      profiles_without_email_count: 2,
      additional_email_identities_count: 3,
      segments_count: 4,
      automations_count: 0,
      paid_subs_count: 0,
      archive_count: 0,
      capabilities: {
        source: "hubspot",
        auth_method: "api_key",
        supports: {
          subscribers: true,
          segments: true,
          automations: false,
          campaign_archive: false,
          paid_subs: false,
          consent_timestamps: true,
        },
      },
    } satisfies DiscoveryReport;

    expect(discovery.additional_email_identities_count).toBe(3);
  });

  it("types cutover evidence payloads with review detail or evidence", () => {
    expect(CUTOVER_EVIDENCE_KEYS).toEqual([
      "activecampaign_consent_exclusion_review",
      "activecampaign_deliverability_review",
      "activecampaign_automation_rebuild_review",
      "activecampaign_segments_review",
      "activecampaign_audience_schema_review",
      "activecampaign_campaign_archive_fidelity_review",
      "activecampaign_templates_review",
      "activecampaign_forms_review",
      "activecampaign_custom_objects_review",
      "activecampaign_ecommerce_review",
      "activecampaign_crm_archive_review",
      "activecampaign_post_pilot_cleanup",
      "beehiiv_consent_reconciliation",
      "beehiiv_segment_rules_review",
      "beehiiv_campaign_archive_fidelity",
      "beehiiv_automation_retirement_review",
      "beehiiv_website_capture_rebuild_review",
      "beehiiv_boosts_recommendations_rebuild_review",
      "beehiiv_ad_network_review",
      "klaviyo_consent_suppression_review",
      "klaviyo_audience_snapshot_review",
      "klaviyo_flow_rebuild_review",
      "klaviyo_channel_identity_review",
      "klaviyo_deliverability_review",
      "klaviyo_ecosystem_dependencies_review",
      "customerio_consent_subscription_review",
      "customerio_identity_audience_review",
      "customerio_automation_rebuild_review",
      "customerio_channel_dependency_review",
      "customerio_deliverability_review",
      "customerio_ecosystem_dependencies_review",
      "hubspot_crm_bridge_scope_review",
      "hubspot_post_pilot_cleanup",
      "sms_readiness",
      "source_discovery_warnings",
      "source_archive_warnings",
    ]);
    const withDetail = {
      key: "source_archive_warnings",
      status: "pass",
      detail: "Source archive warning reviewed after final delta.",
    } satisfies CutoverEvidenceInput;
    const consentExclusionSignoff = {
      key: "activecampaign_consent_exclusion_review",
      evidence: ["Consent and exclusion review attached."],
    } satisfies CutoverEvidenceInput;
    const withEvidence = {
      key: "source_discovery_warnings",
      evidence: ["Discovery warning owner sign-off attached."],
    } satisfies CutoverEvidenceInput;
    const emptyEvidence = {
      key: "source_discovery_warnings",
      // @ts-expect-error evidence-only payloads need at least one evidence entry.
      evidence: [],
    } satisfies CutoverEvidenceInput;
    const manualSurfaceSignoff = {
      key: "activecampaign_crm_archive_review",
      status: "pass",
      detail: "CRM archive gap exported and signed off after final delta.",
      evidence: ["CRM-archive-export-2026-07-07"],
    } satisfies CutoverEvidenceInput;
    const audienceSchemaSignoff = {
      key: "activecampaign_audience_schema_review",
      detail: "Field and tag schema preservation reviewed after final delta.",
    } satisfies CutoverEvidenceInput;
    const campaignFidelitySignoff = {
      key: "activecampaign_campaign_archive_fidelity_review",
      evidence: ["Campaign archive fidelity report reviewed."],
    } satisfies CutoverEvidenceInput;
    const smsReadiness = {
      key: "sms_readiness",
      detail: "SMS pilot readiness passed before this evidence was recorded.",
    } satisfies CutoverEvidenceInput;
    const klaviyoEcosystemReview = {
      key: "klaviyo_ecosystem_dependencies_review",
      evidence: ["Klaviyo ecosystem dependency ledger reviewed."],
    } satisfies CutoverEvidenceInput;
    const unsupportedKey = {
      // @ts-expect-error cutover evidence keys are backend allow-listed.
      key: "activecampaign_unknown_review",
      detail: "Unsupported review key.",
    } satisfies CutoverEvidenceInput;

    expect(withDetail.key).toBe("source_archive_warnings");
    expect(withEvidence.evidence).toHaveLength(1);
    expect(consentExclusionSignoff.key).toBe(
      "activecampaign_consent_exclusion_review",
    );
    expect(emptyEvidence.key).toBe("source_discovery_warnings");
    expect(manualSurfaceSignoff.key).toBe("activecampaign_crm_archive_review");
    expect(audienceSchemaSignoff.key).toBe(
      "activecampaign_audience_schema_review",
    );
    expect(campaignFidelitySignoff.key).toBe(
      "activecampaign_campaign_archive_fidelity_review",
    );
    expect(smsReadiness.key).toBe("sms_readiness");
    expect(klaviyoEcosystemReview.key).toBe(
      "klaviyo_ecosystem_dependencies_review",
    );
    expect(unsupportedKey.detail).toBe("Unsupported review key.");
  });

  it("validates migration source path segments at runtime", () => {
    expect(migrationSourcePathSegment("activecampaign")).toBe("activecampaign");
    expect(migrationSourcePathSegment("klaviyo")).toBe("klaviyo");
    expect(migrationSourcePathSegment("customerio")).toBe("customerio");
    expect(migrationSourcePathSegment("constant-contact")).toBe(
      "constant-contact",
    );
    expect(migrationSourcePathSegment("campaign-monitor")).toBe(
      "campaign-monitor",
    );
    expect(() => migrationSourcePathSegment("mailchimp_api")).toThrow(
      /Unsupported migration source/,
    );
    expect(() =>
      migrationSourcePathSegment("activecampaign/../../admin" as never),
    ).toThrow(/Unsupported migration source/);
  });

  it("encodes migration job path segments", () => {
    expect(migrationJobPathSegment("job/a")).toBe("job%2Fa");
    expect(migrationJobPathSegment(" job/a ")).toBe("job%2Fa");
    expect(() => migrationJobPathSegment(" ")).toThrow(/job ID is required/);
  });

  it("sends a caller-managed Klaviyo bearer without claiming managed OAuth", async () => {
    const seen: Array<{ url: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ job_id: "job/a", account_id: "account_primary" });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.migrations.credentials("klaviyo", {
      access_token: "caller-managed-bearer",
      refresh_token: "caller-managed-refresh",
      account_id: "account_primary",
    });

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/migrations/klaviyo/credentials",
        body: {
          access_token: "caller-managed-bearer",
          refresh_token: "caller-managed-refresh",
          account_id: "account_primary",
        },
      },
    ]);
  });

  it("preserves Customer.io workspace and region credential binding", async () => {
    const seen: Array<{ url: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ job_id: "job/cio", account_id: "9001" });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.migrations.credentials("customerio", {
      api_key: "cio_app_key",
      account_id: "9001",
      extra: { region: "eu" },
    });

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/migrations/customerio/credentials",
        body: {
          api_key: "cio_app_key",
          account_id: "9001",
          extra: { region: "eu" },
        },
      },
    ]);
  });

  it("forwards explicit Mailchimp audience scope and rejects unscoped runs", async () => {
    const seen: Array<{ url: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/discover")) {
        return json({
          job_id: "job/a",
          source: "mailchimp",
          subscribers_count: 3,
          segments_count: 0,
          automations_count: 0,
          paid_subs_count: 0,
          archive_count: 0,
          audiences: [{ id: "aud_a", name: "Primary", subscribers_total: 3 }],
          capabilities: {
            source: "mailchimp",
            auth_method: "oauth2",
            supports: {},
          },
        });
      }
      return json({ job_id: "job/a" });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    const discovery = await pw.migrations.discover("mailchimp", "job/a");
    expect(discovery.job_id).toBe("job/a");
    expect(discovery.audiences?.[0]?.id).toBe("aud_a");
    await pw.migrations.discover("mailchimp", "job/a", ["aud_a"]);
    await pw.migrations.dryRun("mailchimp", "job/a", ["aud_a"]);
    await pw.migrations.commit("mailchimp", "job/a", ["aud_a"]);

    expect(seen.map((request) => request.body)).toEqual([
      { job_id: "job/a" },
      { job_id: "job/a", selected_audience_ids: ["aud_a"] },
      { job_id: "job/a", selected_audience_ids: ["aud_a"] },
      { job_id: "job/a", selected_audience_ids: ["aud_a"] },
    ]);
    expect(() => pw.migrations.dryRun("mailchimp", "job/a")).toThrow(
      /selected audience ID/,
    );
    expect(() => pw.migrations.commit("mailchimp", "job/a", [])).toThrow(
      /selected audience ID/,
    );
  });

  it("reconnects OAuth to the same job and returns rollback acceptance", async () => {
    const seen: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      seen.push(url);
      if (url.includes("/oauth/start")) {
        return json({
          authorize_url: "https://login.mailchimp.com/oauth2/authorize",
          state: "csrf",
        });
      }
      if (url.endsWith("/rollback")) {
        return json({ job_id: "job/a", state: "running" });
      }
      return json({
        state: "running",
        archive_deleted: 0,
        archive_total: 1,
        templates_deleted: 0,
        templates_total: 1,
        automations_deleted: 0,
        automations_total: 0,
        segments_deleted: 0,
        segments_total: 0,
        subscribers_deleted: 0,
        subscribers_total: 3,
        lists_deleted: 0,
        lists_total: 1,
        paid_subs_deleted: 0,
        paid_subs_total: 0,
        started_at: "2026-07-15T00:00:00Z",
      });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.migrations.start("mailchimp", " job/a ");
    const accepted = await pw.migrations.rollback("job/a");
    const progress = await pw.migrations.rollbackStatus("job/a");

    expect(accepted).toEqual({ job_id: "job/a", state: "running" });
    expect(progress.subscribers_deleted).toBe(0);
    expect(seen).toEqual([
      "https://api.moosewave.com/api/v1/migrations/mailchimp/oauth/start?job_id=job%2Fa",
      "https://api.moosewave.com/api/v1/migrations/job%2Fa/rollback",
      "https://api.moosewave.com/api/v1/migrations/job%2Fa/rollback-status",
    ]);
    expect(() => pw.migrations.start("mailchimp", " ")).toThrow(
      /job ID is required for OAuth reconnect/,
    );
  });

  it("encodes job IDs in request paths while keeping body job_id intact", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/pilot-acceptance")) {
        return json({
          job_id: "job/a",
          source: "activecampaign",
          generated_at: "2026-05-20T00:00:00Z",
          status: "pass",
          blockers: 0,
          warnings: 0,
          items: [],
        });
      }
      if (url.endsWith("/cutover-evidence")) {
        return json({
          job_id: "job/a",
          source: "activecampaign",
          generated_at: "2026-05-20T00:00:00Z",
          status: "pass",
          blockers: 0,
          warnings: 0,
          items: [],
        });
      }
      return json({ job_id: "job/a" });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.migrations.dryRun("activecampaign", "job/a");
    await pw.migrations.credentials("activecampaign", {
      api_key: "new_token",
      account_id: "https://acme.api-us1.com/api/3",
    });
    await pw.migrations.startShadowMonitor("activecampaign", "job/a", 900);
    await pw.migrations.shadowMonitor("job/a");
    await pw.migrations.stopShadowMonitor("job/a");
    await pw.migrations.startSourceEvents("activecampaign", "job/a", 900);
    await pw.migrations.sourceEvents("job/a");
    await pw.migrations.stopSourceEvents("job/a", true);
    await pw.migrations.updateSourceEventReview("job/a", "event/a", {
      status: "reviewed",
      detail: "Phone-only contact reconciled.",
      evidence: ["cutover-ticket-42"],
    });
    await pw.migrations.refreshSourceSession("job/a", {
      api_key: "new_token",
      account_id: "https://acme.api-us1.com/api/3",
      extra: { api_url: "https://acme.api-us1.com/api/3" },
    });
    await pw.migrations.pilotAcceptance("job/a");
    await pw.migrations.recordCutoverEvidence("job/a", {
      key: "activecampaign_crm_archive_review",
      status: "pass",
      detail: "CRM archive gap exported and signed off after final delta.",
    });

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/migrations/activecampaign/dry-run",
        method: "POST",
        body: { job_id: "job/a" },
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/activecampaign/credentials",
        method: "POST",
        body: {
          api_key: "new_token",
          account_id: "https://acme.api-us1.com/api/3",
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/sources/activecampaign/shadow-monitor",
        method: "POST",
        body: { job_id: "job/a", interval_seconds: 900 },
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/job%2Fa/shadow-monitor",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/job%2Fa/shadow-monitor",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/sources/activecampaign/source-events",
        method: "POST",
        body: { job_id: "job/a", interval_seconds: 900 },
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/job%2Fa/source-events",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/job%2Fa/source-events?post_pilot_cleanup=1",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/job%2Fa/source-events/event%2Fa/review",
        method: "PATCH",
        body: {
          status: "reviewed",
          detail: "Phone-only contact reconciled.",
          evidence: ["cutover-ticket-42"],
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/job%2Fa/source-session",
        method: "POST",
        body: {
          api_key: "new_token",
          account_id: "https://acme.api-us1.com/api/3",
          extra: { api_url: "https://acme.api-us1.com/api/3" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/job%2Fa/pilot-acceptance",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/job%2Fa/cutover-evidence",
        method: "PATCH",
        body: {
          key: "activecampaign_crm_archive_review",
          status: "pass",
          detail: "CRM archive gap exported and signed off after final delta.",
        },
      },
    ]);
  });

  it("binds Beehiiv credentials and refresh requests to an explicit publication", async () => {
    const seen: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/discover")) {
        return json({
          job_id: "job/a",
          source: "beehiiv",
          subscribers_count: 1,
          segments_count: 0,
          automations_count: 0,
          paid_subs_count: 0,
          archive_count: 0,
          warnings: [],
          audiences: [],
        });
      }
      if (url.endsWith("/shadow-check")) {
        return json({
          job_id: "job/a",
          source: "beehiiv",
          generated_at: "2026-07-16T00:00:00Z",
          attempt_token: "a".repeat(64),
          import_epoch: "b".repeat(64),
          baseline_fingerprint: "c".repeat(64),
          current_discovery: {},
          needs_delta_import: false,
          recommended_action: "ready_for_cutover_review",
          deltas: [],
        });
      }
      if (url.endsWith("/source-session")) {
        return json({ id: "job/a", source: "beehiiv", status: "completed" });
      }
      return json({ job_id: "job/a", account_id: "pub_primary" });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.migrations.credentials("beehiiv", {
      api_key: "beehiiv-secret",
      account_id: "pub_primary",
      extra: { publication_id: "pub_primary" },
    });
    await pw.migrations.discover("beehiiv", "job/a");
    const shadow = await pw.migrations.shadowCheck("beehiiv", "job/a");
    expect(shadow.attempt_token).toBe("a".repeat(64));
    expect(shadow.import_epoch).toBe("b".repeat(64));
    expect(shadow.baseline_fingerprint).toBe("c".repeat(64));
    await pw.migrations.refreshSourceSession("job/a", {
      api_key: "beehiiv-secret-rotated",
      account_id: "pub_primary",
      extra: { publication_id: "pub_primary" },
    });

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/migrations/beehiiv/credentials",
        method: "POST",
        body: {
          api_key: "beehiiv-secret",
          account_id: "pub_primary",
          extra: { publication_id: "pub_primary" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/beehiiv/discover",
        method: "POST",
        body: { job_id: "job/a" },
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/beehiiv/shadow-check",
        method: "POST",
        body: { job_id: "job/a" },
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/job%2Fa/source-session",
        method: "POST",
        body: {
          api_key: "beehiiv-secret-rotated",
          account_id: "pub_primary",
          extra: { publication_id: "pub_primary" },
        },
      },
    ]);
  });

  it("routes HubSpot private app token and pilot-window bridge calls", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/shadow-check")) {
        return json({
          job_id: "job/a",
          source: "hubspot",
          current_discovery: {},
          needs_delta_import: false,
          recommended_action: "ready_for_cutover_review",
          deltas: [],
        });
      }
      if (url.endsWith("/pilot-acceptance")) {
        return json({
          job_id: "job/a",
          source: "hubspot",
          generated_at: "2026-07-08T00:00:00Z",
          status: "pass",
          blockers: 0,
          warnings: 0,
          items: [],
        });
      }
      if (url.endsWith("/rollback-rehearsal")) {
        return json({
          job_id: "job/a",
          source: "hubspot",
          status: "pass",
          total_resources: 0,
          items: [],
        });
      }
      if (url.endsWith("/source-session")) {
        return json({ id: "job/a", source: "hubspot", status: "imported" });
      }
      if (url.endsWith("/delta-import")) {
        return json({ job_id: "job/a", mode: "delta_import" });
      }
      if (
        url.endsWith("/source-events") &&
        (init?.method === "DELETE" || init?.method === undefined)
      ) {
        return json({
          job_id: "job/a",
          enabled: init?.method !== "DELETE",
          monitor: {
            job_id: "job/a",
            source: "hubspot",
            enabled: init?.method !== "DELETE",
            interval_seconds: 900,
          },
          events: [],
        });
      }
      return json({
        job_id: "job/a",
        account_id: "12345",
        monitor: {
          job_id: "job/a",
          source: "hubspot",
          enabled: true,
          interval_seconds: 900,
        },
        events: [],
      });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.migrations.credentials("hubspot", {
      api_key: "pat-secret",
      account_id: "12345",
      extra: { hub_id: "12345" },
    });
    await pw.migrations.startSourceEvents("hubspot", "job/a", 900);
    await pw.migrations.sourceEvents("job/a");
    await pw.migrations.deltaImport("hubspot", "job/a");
    await pw.migrations.shadowCheck("hubspot", "job/a");
    await pw.migrations.refreshSourceSession("job/a", {
      api_key: "pat-secret-rotated",
      account_id: "12345",
      extra: { portal_id: "12345" },
    });
    await pw.migrations.pilotAcceptance("job/a");
    await pw.migrations.rollbackRehearsal("job/a");
    await pw.migrations.stopSourceEvents("job/a");

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/migrations/hubspot/credentials",
        method: "POST",
        body: {
          api_key: "pat-secret",
          account_id: "12345",
          extra: { hub_id: "12345" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/sources/hubspot/source-events",
        method: "POST",
        body: { job_id: "job/a", interval_seconds: 900 },
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/job%2Fa/source-events",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/hubspot/delta-import",
        method: "POST",
        body: { job_id: "job/a" },
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/hubspot/shadow-check",
        method: "POST",
        body: { job_id: "job/a" },
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/job%2Fa/source-session",
        method: "POST",
        body: {
          api_key: "pat-secret-rotated",
          account_id: "12345",
          extra: { portal_id: "12345" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/job%2Fa/pilot-acceptance",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/job%2Fa/rollback-rehearsal",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/migrations/job%2Fa/source-events",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });

  it("rejects unsupported sources before fetch", async () => {
    const fetch = vi.fn(async () => json({}));
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    expect(() => pw.migrations.start("mailchimp_api")).toThrow(
      /Unsupported migration source/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
