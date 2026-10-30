// SPDX-License-Identifier: AGPL-3.0-only
//
// In-memory fakes for the migration endpoints. Used while
// `services/migration` is being built in parallel, and any time the
// `NEXT_PUBLIC_USE_MOCKS=1` env flag is set.

import {
  MIGRATION_SOURCE_PLATFORMS,
  type AdapterCapabilities,
  type AuditEntry,
  type DiscoveryReport,
  type MigrationJob,
  type MigrationProgress,
  type MigrationStatus,
  type RollbackStatus,
  type SourcePlatform,
  type VerificationReport,
} from "./types";

function capability(
  source: SourcePlatform,
  authMethod: AdapterCapabilities["auth_method"],
  supports: Partial<AdapterCapabilities["supports"]> = {},
): AdapterCapabilities {
  return {
    source,
    auth_method: authMethod,
    supports: {
      subscribers: true,
      segments: true,
      automations: false,
      campaign_archive: false,
      paid_subs: false,
      consent_timestamps: true,
      templates: false,
      campaigns: true,
      reports: true,
      groups: false,
      forms: false,
      landing_pages: false,
      ecommerce: false,
      ...supports,
    },
  };
}

const CAPABILITIES: Record<SourcePlatform, AdapterCapabilities> = {
  mailchimp: {
    source: "mailchimp",
    auth_method: "oauth2",
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      campaign_archive: true,
      paid_subs: false,
      consent_timestamps: true,
      templates: false,
      campaigns: true,
      reports: true,
      groups: true,
      forms: true,
      landing_pages: true,
      ecommerce: true,
    },
  },
  klaviyo: capability("klaviyo", "api_key", {
    automations: true,
    automation_mode: "rebuild_review",
    campaign_archive: true,
    templates: true,
    reports: false,
    forms: true,
    ecommerce: false,
    sms: false,
  }),
  customerio: capability("customerio", "api_key", {
    automations: true,
    automation_mode: "rebuild_review",
    campaign_archive: true,
    consent_timestamps: false,
    reports: false,
    custom_objects: false,
    sms: false,
  }),
  "constant-contact": capability("constant-contact", "api_key", {
    campaign_archive: true,
    templates: true,
    forms: true,
  }),
  aweber: capability("aweber", "api_key", {
    automations: true,
    campaign_archive: true,
    forms: true,
  }),
  drip: capability("drip", "api_key", {
    automations: true,
    campaign_archive: true,
    ecommerce: true,
  }),
  "campaign-monitor": capability("campaign-monitor", "api_key", {
    campaign_archive: true,
    templates: true,
  }),
  omnisend: capability("omnisend", "api_key", {
    automations: true,
    campaign_archive: true,
    ecommerce: true,
    sms: true,
  }),
  loops: capability("loops", "api_key", {
    automations: true,
    campaign_archive: true,
  }),
  flodesk: capability("flodesk", "api_key", {
    campaign_archive: true,
    forms: true,
    landing_pages: true,
  }),
  bento: capability("bento", "api_key", {
    automations: true,
    campaign_archive: true,
    custom_objects: true,
    ecommerce: true,
  }),
  activecampaign: {
    source: "activecampaign",
    auth_method: "api_key",
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      campaign_archive: true,
      paid_subs: false,
      consent_timestamps: true,
      templates: false,
      campaigns: true,
      reports: true,
      groups: true,
      forms: true,
      landing_pages: false,
      ecommerce: true,
      crm: true,
      custom_objects: true,
      sms: true,
    },
  },
  hubspot: {
    source: "hubspot",
    auth_method: "api_key",
    supports: {
      subscribers: true,
      segments: true,
      automations: false,
      campaign_archive: false,
      paid_subs: false,
      consent_timestamps: true,
      templates: false,
      campaigns: false,
      reports: false,
      groups: true,
      forms: false,
      landing_pages: false,
      ecommerce: false,
      crm: true,
      custom_objects: false,
      sms: false,
    },
  },
  convertkit: {
    source: "convertkit",
    auth_method: "oauth2",
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      campaign_archive: true,
      paid_subs: true,
      consent_timestamps: false,
      templates: false,
      campaigns: true,
      reports: true,
      groups: true,
      forms: false,
      landing_pages: false,
      ecommerce: false,
    },
  },
  substack: {
    source: "substack",
    auth_method: "csv_upload",
    supports: {
      subscribers: true,
      segments: false,
      automations: false,
      campaign_archive: true,
      paid_subs: false,
      consent_timestamps: false,
      templates: false,
      campaigns: true,
      reports: true,
      groups: false,
      forms: false,
      landing_pages: false,
      ecommerce: false,
    },
  },
  beehiiv: {
    source: "beehiiv",
    auth_method: "api_key",
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      campaign_archive: true,
      paid_subs: false,
      consent_timestamps: false,
      templates: false,
      campaigns: true,
      reports: true,
      groups: true,
      forms: false,
      landing_pages: false,
      ecommerce: false,
    },
  },
  mailerlite: {
    source: "mailerlite",
    auth_method: "api_key",
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      campaign_archive: true,
      paid_subs: false,
      consent_timestamps: true,
      templates: false,
      campaigns: true,
      reports: true,
      groups: true,
      forms: false,
      landing_pages: false,
      ecommerce: false,
    },
  },
  brevo: {
    source: "brevo",
    auth_method: "api_key",
    supports: {
      subscribers: true,
      segments: true,
      automations: false,
      campaign_archive: true,
      paid_subs: false,
      consent_timestamps: false,
      templates: false,
      campaigns: true,
      reports: true,
      groups: false,
      forms: false,
      landing_pages: false,
      ecommerce: false,
    },
  },
  sendy: {
    source: "sendy",
    auth_method: "csv_upload",
    supports: {
      subscribers: true,
      segments: false,
      automations: false,
      campaign_archive: false,
      paid_subs: false,
      consent_timestamps: true,
      templates: false,
      campaigns: false,
      reports: false,
      groups: false,
      forms: false,
      landing_pages: false,
      ecommerce: false,
    },
  },
  csv: {
    source: "csv",
    auth_method: "csv_upload",
    supports: {
      subscribers: true,
      segments: false,
      automations: false,
      campaign_archive: false,
      paid_subs: false,
      consent_timestamps: true,
      templates: false,
      campaigns: false,
      reports: false,
      groups: false,
      forms: false,
      landing_pages: false,
      ecommerce: false,
    },
  },
};

export function mockCapabilities(): AdapterCapabilities[] {
  return MIGRATION_SOURCE_PLATFORMS.map((source) => CAPABILITIES[source]);
}

export function mockCapability(source: SourcePlatform): AdapterCapabilities {
  return CAPABILITIES[source];
}

export function mockDiscovery(source: SourcePlatform): DiscoveryReport {
  const seed = source.length;
  const base: DiscoveryReport = {
    source,
    subscribers_count: 12_400 + seed * 37,
    segments_count: 8 + (seed % 5),
    automations_count: 4 + (seed % 3),
    archive_count: 142,
    campaigns_count: 142,
    reports_count: 142,
    paid_subs_count: source === "substack" || source === "beehiiv" ? 312 : 0,
    custom_fields: ["first_name", "last_name", "signup_source", "city"],
    warnings: sourceWarnings(source),
  };
  if (source === "mailchimp") {
    base.templates_count = 36;
    base.campaigns_count = 168;
    base.reports_count = 142;
    base.groups_count = 12;
    base.forms_count = 3;
    base.landing_pages_count = 2;
    base.ecommerce_count = 1;
    base.audiences = [
      {
        id: "list_newsletter",
        name: "Newsletter",
        subscribers_total: 8800,
      },
      {
        id: "list_customers",
        name: "Customers",
        subscribers_total: 3200,
      },
      {
        id: "list_events",
        name: "Events",
        subscribers_total: base.subscribers_count - 12000,
      },
    ];
  }
  if (source === "activecampaign") {
    base.templates_count = 42;
    base.campaigns_count = 210;
    base.reports_count = 198;
    base.groups_count = 24;
    base.forms_count = 8;
    base.ecommerce_count = 3;
    base.deals_count = 510;
    base.pipelines_count = 4;
    base.crm_count = base.deals_count + base.pipelines_count;
    base.custom_objects_count = 9;
    base.sms_campaigns_count = 18;
  }
  if (source === "klaviyo") {
    base.profiles_without_email_count = 84;
    base.templates_count = 28;
    base.campaigns_count = 154;
    base.reports_count = 0;
    base.forms_count = 5;
    base.sms_campaigns_count = 12;
    base.push_campaigns_count = 7;
    base.source_archive_count = 26;
    base.audiences = [
      {
        id: "klaviyo:list:L_UNNAMED",
        name: "Klaviyo list L_UNNAMED",
        subscribers_total: 7_200,
      },
      {
        id: "klaviyo:segment:S_UNNAMED",
        name: "Klaviyo segment S_UNNAMED",
        subscribers_total: 3_100,
      },
    ];
  }
  if (source === "customerio") {
    base.profiles_without_email_count = 37;
    base.segments_count = 3;
    base.automations_count = 28;
    base.archive_count = 32;
    base.templates_count = 12;
    base.campaigns_count = 70;
    base.reports_count = 0;
    base.custom_objects_count = 4;
    base.subscription_channels_count = 3;
    base.sms_campaigns_count = 8;
    base.push_campaigns_count = 6;
    base.audiences = [
      {
        id: "customerio:segment:vip",
        name: "VIP",
        subscribers_total: 3_100,
      },
      {
        id: "customerio:segment:engaged",
        name: "Engaged",
        subscribers_total: 7_200,
      },
      {
        id: "customerio:topic:product",
        name: "Product updates",
        subscribers_total: 8_900,
      },
    ];
    base.source_archive_count = Object.values(
      customerIOSourceArchiveByResource(base),
    ).reduce((total, count) => total + count, 0);
  }
  if (source === "hubspot") {
    base.profiles_without_email_count = 41;
    base.additional_email_identities_count = 27;
    base.subscription_channels_count = 3;
    base.archive_count = 0;
    base.campaigns_count = 0;
    base.reports_count = 0;
    base.automations_count = 0;
    base.groups_count = 64;
    base.segments_count = 18;
    base.crm_count = base.subscribers_count + base.profiles_without_email_count;
  }
  if (source === "convertkit") {
    base.groups_count = 18;
    base.forms_count = 6;
    base.landing_pages_count = 3;
  }
  if (source === "substack") {
    base.source_archive_count = 16;
    base.reports_count = 48;
  }
  if (source === "beehiiv") {
    base.groups_count = 3;
  }
  if (source === "mailerlite") {
    base.groups_count = 14;
    base.segments_count = 18;
    base.templates_count = 0;
    base.campaigns_count = 148;
    base.reports_count = base.archive_count;
    base.forms_count = 7;
    base.landing_pages_count = 0;
    base.ecommerce_count = 2;
    base.source_archive_count =
      (base.custom_fields?.length ?? 0) +
      (base.campaigns_count - base.archive_count) +
      base.forms_count +
      base.ecommerce_count +
      1;
  }
  if (source === "brevo") {
    base.groups_count = 12;
    base.templates_count = 15;
    base.campaigns_count = 88;
    base.reports_count = 80;
  }
  if (source === "csv") {
    base.segments_count = 0;
    base.automations_count = 0;
    base.archive_count = 0;
    base.campaigns_count = 0;
    base.reports_count = 0;
  }
  base.resource_metadata = sourceCompleteness(source, base, {
    subscribers_imported: base.subscribers_count,
    segments_translated: base.segments_count,
    automations_translated:
      source === "activecampaign" ||
      source === "klaviyo" ||
      source === "customerio"
        ? 0
        : base.automations_count,
    paid_subs_imported: 0,
    archive_imported: base.archive_count,
  });
  return base;
}

function emptyProgress(): MigrationProgress {
  return {
    subscribers_total: 0,
    subscribers_done: 0,
    segments_total: 0,
    segments_done: 0,
    automations_total: 0,
    automations_done: 0,
    paid_subs_total: 0,
    paid_subs_done: 0,
    archive_total: 0,
    archive_done: 0,
  };
}

// Substantive mock verification report — used by both the wizard's review
// step and the new /migrations/[jobId] detail page in mock mode.
//
// Spec from plan.md Phase 3 says the demo report should include:
//   - 2 unmapped custom fields
//   - 1 segment-level warning
//   - 1 unsupported automation
//   - ~0.3% data loss
//
// We keep the shape source-aware so demos for sources that don't have
// runtime automations / billing objects still feel right for sources that
// support them. Substack's paid_subs_count is membership evidence only.
export function mockVerification(
  sourceOrJobId: SourcePlatform | string,
): VerificationReport {
  // Accept either a SourcePlatform or a job_id and try to look up the job's
  // source in the in-memory store; fall back to mailchimp.
  const fromJob =
    typeof sourceOrJobId === "string" ? JOBS.get(sourceOrJobId) : null;
  const source: SourcePlatform =
    fromJob?.source ??
    (isSourcePlatform(sourceOrJobId)
      ? sourceOrJobId
      : (sourceFromMockJobID(sourceOrJobId) ?? "mailchimp"));

  const discovery = mockDiscovery(source);
  const hasAutomations = source !== "substack" && source !== "csv";
  const hasRuntimeAutomations =
    hasAutomations &&
    mockCapability(source).supports.automation_mode !== "rebuild_review";
  const hasPaidSubs = mockCapability(source).supports.paid_subs;

  const report: VerificationReport = {
    subscribers_imported:
      source === "customerio" ? discovery.subscribers_count : 12_400,
    suppression_list_size: 187,
    // MIGR-028: preview rows so mock mode renders the sample table.
    sample_subscribers: [
      {
        email: "a***@example.com",
        status: source === "substack" ? "unconfirmed" : "enabled",
        tags: ["vip", "newsletter"],
        source_id: "src:1001",
        custom_fields: { first_name: "Ada", company: "Analytical Engines" },
      },
      {
        email: "b***@example.com",
        status: source === "substack" ? "unconfirmed" : "enabled",
        tags: ["trial"],
        source_id: "src:1002",
        custom_fields: { first_name: "Bram", city: "Dublin" },
      },
      {
        email: "c***@example.com",
        status: "unsubscribed",
        tags: [],
        source_id: "src:1003",
        custom_fields: { first_name: "Cyra" },
      },
    ],
    custom_fields_mapped: [
      { source: "FNAME", canonical: "first_name", type: "string" },
      { source: "LNAME", canonical: "last_name", type: "string" },
      { source: "CITY", canonical: "custom.city", type: "string" },
      { source: "COMPANY", canonical: "company", type: "string" },
      {
        source: "SIGNUP_SOURCE",
        canonical: "custom.signup_source",
        type: "string",
      },
    ],
    custom_fields_unmapped: ["MMERGE7", "INTEREST_GROUP_2"],
    segments_translated:
      source === "customerio"
        ? discovery.segments_count
        : source === "mailerlite"
          ? (discovery.groups_count ?? 0)
          : 7,
    segments_with_warnings:
      source === "beehiiv"
        ? [
            {
              name: "Engaged + opened last 30 days",
              warning:
                "Beehiiv API v2 does not expose the saved predicate. Current completed membership is frozen for cutover; rebuild and test the dynamic rule.",
            },
          ]
        : source === "klaviyo"
          ? [
              {
                name: "High-intent dynamic segment",
                warning:
                  "Current Klaviyo membership is frozen for cutover. Rebuild and validate the dynamic predicate before relying on future membership changes.",
              },
            ]
          : source === "customerio"
            ? [
                {
                  name: "High-intent Customer.io segment",
                  warning:
                    "Current membership is frozen for cutover because Customer.io does not expose a portable saved predicate through this adapter. Rebuild and validate the dynamic rule.",
                },
              ]
            : source === "mailerlite"
              ? [
                  {
                    name: "Engaged readers",
                    warning:
                      "MailerLite exposes saved-segment metadata and membership reads but not the dynamic predicate definition. Rebuild and test the rule before cutover.",
                  },
                ]
              : [
                  {
                    name: "Engaged + opened last 30 days",
                    warning:
                      "Open events older than 30 days are not in the export — segment will only count future opens.",
                  },
                ],
    automations_translated:
      source === "mailchimp"
        ? Math.min(1, discovery.automations_count)
        : hasRuntimeAutomations
          ? 3
          : 0,
    automations_unsupported:
      source === "activecampaign"
        ? activeCampaignUnsupportedAutomations(discovery.automations_count)
        : source === "mailchimp"
          ? [
              {
                name: "Customer Journeys / unsupported Classic workflows",
                reason:
                  "Mailchimp does not expose a supported general Customer Journey list/graph export. Only fully resolved Classic welcome-series automations can import, paused; the generic Journey warning is not inventory, and all other workflows require manual rebuild review.",
              },
            ]
          : source === "beehiiv"
            ? Array.from(
                { length: discovery.automations_count },
                (_, index) => ({
                  name: `Beehiiv automation ${index + 1}`,
                  reason:
                    "Beehiiv API v2 exposes metadata, email inventory, and statistics, but not an executable graph or message bodies. Preserve as rebuild evidence and recreate manually.",
                }),
              )
            : source === "klaviyo"
              ? Array.from(
                  { length: discovery.automations_count },
                  (_, index) => ({
                    name: `Klaviyo flow ${index + 1}`,
                    reason:
                      "Klaviyo flow trigger metadata and source evidence are preserved, but the executable graph, splits, webhooks, message variants, and profile/list update actions require rebuild review.",
                  }),
                )
              : source === "customerio"
                ? Array.from(
                    { length: discovery.automations_count },
                    (_, index) => ({
                      name: `Customer.io automation ${index + 1}`,
                      reason:
                        "Customer.io campaign/action definitions and trigger metadata are preserved for rebuild review; multi-channel behavior is never activated automatically.",
                    }),
                  )
                : source === "mailerlite"
                  ? Array.from(
                      { length: discovery.automations_count },
                      (_, index) => ({
                        name: `MailerLite automation ${index + 1}`,
                        reason:
                          "MailerLite trigger and step payloads are preserved, but provider-specific graph semantics and rendered message bodies require rebuild review.",
                      }),
                    )
                  : hasAutomations
                    ? [
                        {
                          name: "Goal-based welcome",
                          reason:
                            "Goal tracking is not supported in Moosewave. Recreate manually in Sequences using a tag-based trigger.",
                        },
                      ]
                    : [],
    paid_subs_imported: hasPaidSubs ? 312 : 0,
    archive_imported: discovery.archive_count,
    source_archive_imported: discovery.source_archive_count ?? 0,
    data_loss_estimate_pct: 0.3,
  };
  if (source === "customerio") {
    report.source_archive_by_resource =
      customerIOSourceArchiveByResource(discovery);
  }
  if (source === "mailerlite") {
    report.source_archive_by_resource = {
      mailerlite_custom_field: discovery.custom_fields?.length ?? 0,
      mailerlite_campaign_rebuild: Math.max(
        0,
        (discovery.campaigns_count ?? discovery.archive_count) -
          discovery.archive_count,
      ),
      mailerlite_form: discovery.forms_count ?? 0,
      mailerlite_ecommerce_shop: discovery.ecommerce_count ?? 0,
      "parity_gap:sites_landing_pages": 1,
    };
  }
  report.resource_completeness = sourceCompleteness(source, discovery, report);
  return report;
}

function customerIOSourceArchiveByResource(
  discovery: DiscoveryReport,
): Record<string, number> {
  const campaignWorkflows = Math.min(18, discovery.automations_count);
  const broadcastWorkflows = Math.max(
    0,
    discovery.automations_count - campaignWorkflows,
  );
  const topicDefinitions = (discovery.audiences ?? []).filter((audience) =>
    audience.id.startsWith("customerio:topic:"),
  ).length;
  return {
    customerio_campaign_workflow: campaignWorkflows,
    customerio_broadcast_workflow: broadcastWorkflows,
    customerio_newsletter: discovery.campaigns_count ?? 0,
    customerio_transactional_message: 8,
    customerio_design_email_rebuild: 3,
    customerio_subscription_topic: topicDefinitions,
    customerio_subscription_channel: discovery.subscription_channels_count ?? 0,
    customerio_esp_suppression: 12,
    customerio_channel_optout: 10,
    customerio_object_type: discovery.custom_objects_count ?? 0,
    customerio_migration_checklist: 8,
  };
}

function activeCampaignUnsupportedAutomations(
  count: number,
): VerificationReport["automations_unsupported"] {
  return Array.from({ length: count }, (_, index) => ({
    name: `ActiveCampaign automation ${index + 1}`,
    reason:
      "ActiveCampaign automation source definitions are preserved for rebuild review; non-executable placeholders are not activated as Moosewave runtime automation rows.",
  }));
}

function sourceCompleteness(
  source: SourcePlatform,
  d: DiscoveryReport,
  imported: Pick<
    VerificationReport,
    | "subscribers_imported"
    | "segments_translated"
    | "automations_translated"
    | "paid_subs_imported"
    | "archive_imported"
    | "source_archive_by_resource"
  >,
): VerificationReport["resource_completeness"] {
  const row = (
    resource: string,
    label: string,
    sourceTotal: number,
    importedCount: number,
    supported: boolean,
    notes: string[],
    forceGap = false,
  ) => ({
    resource,
    label,
    source_total: sourceTotal,
    imported: importedCount,
    supported,
    status: statusFor(
      sourceTotal,
      importedCount,
      supported,
      forceGap,
      resource,
    ),
    notes,
  });

  if (source === "customerio") {
    const topicDefinitions = (d.audiences ?? []).filter((audience) =>
      audience.id.startsWith("customerio:topic:"),
    ).length;
    const preferenceDefinitions =
      topicDefinitions + (d.subscription_channels_count ?? 0);
    return [
      row(
        "subscribers",
        "Email-addressable Customer.io profiles",
        d.subscribers_count,
        imported.subscribers_imported,
        true,
        [
          "Profiles import under immutable cio_id identity. Global, email-channel, and applicable topic state resolve conservatively; source timestamps remain provenance rather than portable consent proof.",
        ],
      ),
      row(
        "non_email_profiles",
        "Customer.io profiles without email",
        d.profiles_without_email_count ?? 0,
        0,
        false,
        [
          "Phone-only, push-only, and identifier-only profiles require an explicit migration or retirement decision; no email address is fabricated.",
        ],
        (d.profiles_without_email_count ?? 0) > 0,
      ),
      row(
        "segments",
        "Segment and subscription-topic snapshots",
        d.segments_count,
        imported.segments_translated,
        true,
        [
          "Membership is frozen at cutover. Dynamic Customer.io predicates must be rebuilt or retired.",
        ],
        true,
      ),
      row(
        "subscription_topics",
        "Subscription-topic and channel definitions",
        preferenceDefinitions,
        preferenceDefinitions,
        true,
        [
          "Topic and subscription-center channel definitions are preserved separately from sender-specific SMS and WhatsApp opt-outs.",
        ],
        true,
      ),
      row(
        "campaigns",
        "Sent email newsletter archive",
        d.archive_count,
        imported.archive_imported,
        true,
        [
          'Only sent email newsletters with at least one explicit language="" default and provably composable source HTML become immutable campaign history; the lowest stable content ID represents a warned multi-default/A-B set, every variant remains evidence, and translations are never silently selected.',
          "A missing or empty layout uses the exact non-empty source body with a fidelity warning; a non-empty layout must contain exactly one documented {{content}} slot. Newsletter and Design Studio HTML are exact source content/composition, not provider-rendered output.",
        ],
      ),
      row(
        "source_archive",
        "Exact Customer.io source archive",
        d.source_archive_count ?? 0,
        d.source_archive_count ?? 0,
        true,
        [
          "Non-executable workflow, channel, consent, object, trigger, and ecosystem evidence is preserved for rebuild review. API-broadcast trigger rows retain only IDs plus created/processed timestamps; original payloads, audiences, and per-user data require manual reconciliation.",
        ],
        true,
      ),
      row(
        "workflow_definitions",
        "Campaign and API-broadcast workflow definitions",
        d.automations_count,
        d.automations_count,
        true,
        [
          "Definitions and available trigger timing evidence are preserved, but no executable automation is activated.",
        ],
        true,
      ),
      row(
        "transactional",
        "Transactional message definitions",
        0,
        0,
        true,
        [
          "Transactional definitions remain within source-archive evidence and require trigger and delivery rebuild testing.",
        ],
        true,
      ),
      row(
        "templates",
        "Editable Design Studio source templates",
        d.templates_count ?? 0,
        d.templates_count ?? 0,
        true,
        [
          "Source HTML is retained under stable identity; Customer.io layout, component, and transformer fidelity requires review.",
        ],
      ),
      row(
        "structured_templates",
        "Design Studio definitions requiring rebuild",
        0,
        0,
        true,
        [
          "Structured editor semantics, layouts, snippets, and assets require review.",
        ],
        true,
      ),
      row(
        "consent_exclusions",
        "ESP suppressions and SMS/WhatsApp sender opt-outs",
        0,
        0,
        true,
        [
          "Global, email-channel, topic, and ESP suppression state must agree before send activation; sender opt-outs are separate non-email evidence.",
        ],
        true,
      ),
      row(
        "channel_dependencies",
        "SMS, push, in-app, and other channel dependencies",
        (d.sms_campaigns_count ?? 0) +
          (d.push_campaigns_count ?? 0) +
          (d.profiles_without_email_count ?? 0),
        0,
        false,
        [
          "This email bridge does not activate non-email identities or runtime.",
        ],
        true,
      ),
      row(
        "custom_objects",
        "Customer.io custom object type metadata",
        d.custom_objects_count ?? 0,
        d.custom_objects_count ?? 0,
        true,
        [
          "Object profiles and relationships require a separate provider export and rebuild review.",
        ],
        true,
      ),
      row(
        "deliverability",
        "Customer.io deliverability and sender cutover",
        1,
        1,
        true,
        [
          "One static checklist record prompts sender and deliverability review.",
        ],
        true,
      ),
      row(
        "ecosystem",
        "Customer.io ecosystem dependencies",
        7,
        7,
        true,
        [
          "Seven static checklist records prompt retained-source and rebuild review.",
        ],
        true,
      ),
    ];
  }

  if (source === "mailchimp") {
    return [
      {
        resource: "templates",
        label: "Templates",
        source_total: d.templates_count ?? 0,
        imported: d.templates_count ?? 0,
        supported: true,
        status: statusFor(
          d.templates_count ?? 0,
          d.templates_count ?? 0,
          true,
          false,
        ),
        notes: [
          "Template HTML is preserved as imported reusable content; visual editor cleanup may still be needed.",
        ],
      },
      {
        resource: "campaigns",
        label: "Campaigns",
        source_total: d.campaigns_count ?? d.archive_count,
        imported: d.archive_count,
        supported: true,
        status: "partial_runtime",
        notes: [
          "Sent campaigns import into the archive; drafts and scheduled campaigns should be recreated.",
        ],
      },
      {
        resource: "automations",
        label: "Classic Automations",
        source_total: d.automations_count,
        imported: imported.automations_translated,
        supported: true,
        status: "partial_runtime",
        notes: [
          "Only fully resolved Classic welcome-series automations import, paused. Other Classic workflow types remain in manual rebuild state.",
        ],
      },
      {
        resource: "customer_journeys",
        label: "Customer Journeys",
        source_total: 0,
        imported: 0,
        supported: false,
        status: "manual_rebuild_required",
        notes: [
          "Mailchimp does not expose a supported general Journey graph export, so source inventory and behavior must be rebuilt and tested manually.",
        ],
      },
      {
        resource: "reports",
        label: "Report history",
        source_total: d.reports_count ?? d.archive_count,
        imported: d.reports_count ?? d.archive_count,
        supported: true,
        status: statusFor(
          d.reports_count ?? d.archive_count,
          d.reports_count ?? d.archive_count,
          true,
          false,
        ),
        notes: [
          "Historical sends keep aggregate opens, clicks, bounces, unsubscribes, and revenue where available.",
        ],
      },
      {
        resource: "groups",
        label: "Groups and interests",
        source_total: d.groups_count ?? 0,
        imported: d.groups_count ?? 0,
        supported: true,
        status: "imported_runtime",
        notes: ["Interest memberships map to subscriber tags."],
      },
      {
        resource: "forms",
        label: "Signup forms",
        source_total: d.forms_count ?? 0,
        imported: d.forms_count ?? 0,
        supported: true,
        status: statusFor(d.forms_count ?? 0, d.forms_count ?? 0, true, false),
        notes: [
          "Embedded and hosted form definitions are preserved so they can be published from Moosewave.",
        ],
      },
      {
        resource: "landing",
        label: "Landing pages",
        source_total: d.landing_pages_count ?? 0,
        imported: d.landing_pages_count ?? 0,
        supported: true,
        status: statusFor(
          d.landing_pages_count ?? 0,
          d.landing_pages_count ?? 0,
          true,
          false,
        ),
        notes: [
          "Landing page structure, slug, SEO, and signup attachment are preserved for review.",
        ],
      },
      {
        resource: "ecommerce",
        label: "Ecommerce",
        source_total: d.ecommerce_count ?? 0,
        imported: d.ecommerce_count ?? 0,
        supported: true,
        status: statusFor(
          d.ecommerce_count ?? 0,
          d.ecommerce_count ?? 0,
          true,
          false,
        ),
        notes: [
          "Store connections, products, customers, orders, and attributed revenue are preserved when present.",
        ],
      },
    ];
  }
  if (source === "klaviyo") {
    return [
      row(
        "subscribers",
        "Primary-email profiles",
        d.subscribers_count,
        imported.subscribers_imported,
        true,
        [
          "The primary email identity exposed by Klaviyo's stable Get Profiles response imports with available email-marketing consent/suppression state, source IDs, profile/predictive properties, and exact enumerated list/segment tags after validated list-level suppressions are excluded. Counts represent the send-targetable projection, not raw provider membership, which the adapter does not expose separately. This row cannot certify secondary-address or independent per-address consent parity.",
        ],
      ),
      row(
        "segments",
        "Lists and dynamic segment snapshots",
        d.segments_count,
        d.segments_count,
        true,
        [
          "Exact enumerated list and segment membership is preserved only after validated list-level suppressions are excluded. This is the send-targetable projection; the adapter does not expose a separate raw membership count. Dynamic predicates require rebuild review.",
        ],
        true,
      ),
      row(
        "automations",
        "Klaviyo flows",
        d.automations_count,
        d.automations_count,
        true,
        [
          "Flow trigger metadata and source evidence are preserved; executable graphs, splits, webhooks, message variants, and profile/list actions require rebuild review. A nullable source definition is retained with an explicit not-rebuild-complete warning rather than treated as an executable flow.",
        ],
        true,
      ),
      row(
        "campaigns",
        "Sent email campaign archive",
        d.archive_count,
        imported.archive_imported,
        true,
        [
          "Only sent email campaigns materialize as destination email archive rows, and a complete message definition is required. Draft campaign-message definitions may be null and remain explicit incomplete rebuild evidence; sender credentials and reporting metrics are not activated. Campaign tag relationships preserve provider IDs only, not resolved tag names.",
        ],
      ),
      row(
        "templates",
        "Editable templates",
        d.templates_count ?? 0,
        d.templates_count ?? 0,
        true,
        [
          "Editable template HTML imports; editor-specific blocks may need polish.",
        ],
      ),
      row(
        "forms",
        "Signup forms and onsite targeting",
        d.forms_count ?? 0,
        d.forms_count ?? 0,
        true,
        [
          "Form evidence is preserved for rebuild; targeting, experiments, rewards, and coupon handoff require review.",
        ],
        true,
      ),
      row(
        "non_email_campaigns",
        "Sent SMS and push source-archive evidence",
        (d.sms_campaigns_count ?? 0) + (d.push_campaigns_count ?? 0),
        (d.sms_campaigns_count ?? 0) + (d.push_campaigns_count ?? 0),
        true,
        [
          "Sent SMS and push records are preserved only as non-executable source-archive evidence and never materialize as email campaign rows. Sender registration, provider credentials, app push credentials, and non-email-only identities are not imported.",
        ],
        true,
      ),
      row(
        "ecommerce",
        "Catalogs, products, orders, coupons, recommendations",
        1,
        1,
        false,
        [
          "This is one unconditional static checklist record, not proof that the Klaviyo account contains commerce inventory. Commerce data is not imported by this adapter.",
        ],
        true,
      ),
      row(
        "reviews",
        "Reviews",
        1,
        1,
        false,
        [
          "This is one unconditional static checklist record, not proof that the Klaviyo account contains review inventory. Review data requires a separate export or rebuild decision.",
        ],
        true,
      ),
      row(
        "service",
        "Customer Hub, Helpdesk, Customer Agent",
        1,
        1,
        false,
        [
          "This is one unconditional static checklist record, not proof that the Klaviyo account uses service-suite products. Service data requires a separate migration decision.",
        ],
        true,
      ),
      row(
        "cdp",
        "Custom objects, transformations, warehouse sync/import",
        1,
        1,
        false,
        [
          "This is one unconditional static checklist record, not proof that the Klaviyo account contains CDP inventory. Those resources are not imported automatically.",
        ],
        true,
      ),
      row(
        "multi_email_profiles",
        "Secondary email identities and per-address consent",
        1,
        1,
        false,
        [
          "This is one unconditional mandatory checklist record, not a count of affected profiles. Klaviyo's stable Get Profiles response does not expose secondary email identifiers or their independent consent/suppression state; reconcile a provider export or retained Klaviyo access before cutover.",
        ],
        true,
      ),
      row(
        "omni_channels",
        "SMS, WhatsApp, RCS, push channel state",
        1,
        1,
        false,
        [
          "This is one unconditional static checklist record, not proof that every channel is configured in the source account. Channel identities, senders, credentials, and executable runtime are not imported.",
        ],
        true,
      ),
      row(
        "deliverability",
        "Deliverability setup",
        1,
        1,
        false,
        [
          "This is one unconditional static checklist record, not proof of a detected deliverability configuration. DNS, domains, tracking, routing, and warmup require review.",
        ],
        true,
      ),
      row(
        "marketplace",
        "Apps and partner integrations",
        1,
        1,
        false,
        [
          "This is one unconditional static checklist record, not proof that installed apps were inventoried. Apps, OAuth installs, webhooks, and credentials require a separate retained-source review.",
        ],
        true,
      ),
    ];
  }
  if (source === "convertkit") {
    return [
      row(
        "campaigns",
        "Broadcasts",
        d.campaigns_count ?? d.archive_count,
        imported.archive_imported,
        true,
        [
          "Sent broadcasts import into the archive; drafts and scheduled broadcasts should be recreated.",
        ],
      ),
      row(
        "automations",
        "Sequences",
        d.automations_count,
        imported.automations_translated,
        true,
        [
          "Sequences translate into Moosewave automations; visual rules and goals require review.",
        ],
      ),
      row(
        "reports",
        "Broadcast reports",
        d.reports_count ?? d.archive_count,
        imported.archive_imported,
        true,
        ["Aggregate opens and clicks are preserved with archived broadcasts."],
      ),
      row("groups", "Tags", d.groups_count ?? 0, d.groups_count ?? 0, true, [
        "Kit tags map to Moosewave subscriber tags.",
      ]),
      row(
        "paid_subs",
        "Paid subscriptions",
        d.paid_subs_count,
        imported.paid_subs_imported,
        true,
        ["Paid-reader data imports from connected Stripe when available."],
        true,
      ),
      row(
        "templates",
        "Email templates",
        d.templates_count ?? 0,
        0,
        false,
        ["Kit templates are not imported as editable templates yet."],
        true,
      ),
      row(
        "forms",
        "Forms",
        d.forms_count ?? 0,
        0,
        false,
        ["Forms and incentive downloads must be rebuilt in Moosewave."],
        true,
      ),
      row(
        "landing",
        "Landing pages",
        d.landing_pages_count ?? 0,
        0,
        false,
        ["Kit landing pages are not imported automatically."],
        true,
      ),
      row(
        "ecommerce",
        "Commerce products",
        d.ecommerce_count ?? 0,
        0,
        false,
        ["Kit commerce products and purchases are not imported directly."],
        true,
      ),
    ];
  }
  if (source === "activecampaign") {
    return [
      row(
        "subscribers",
        "Email-addressable contacts",
        d.subscribers_count,
        imported.subscribers_imported,
        true,
        [
          "Contacts import with channel-specific list evidence; list status and subscription dates remain provenance, and incomplete consent/exclusion evidence stays unconfirmed.",
        ],
      ),
      row("non_email_contacts", "Email-less contacts", 0, 0, true, [
        "Email-less and phone-only contacts are preserved for review rather than fabricated into the email-keyed subscriber destination.",
      ]),
      row(
        "consent_exclusions",
        "Email consent and exclusions",
        d.subscribers_count,
        0,
        true,
        [
          "Channel consent and ActiveCampaign exclusions require explicit reconciliation before audience activation.",
        ],
        true,
      ),
      row(
        "campaigns",
        "Campaigns",
        d.campaigns_count ?? d.archive_count,
        imported.archive_imported,
        true,
        [
          "Completed campaigns are hydrated from campaign detail plus linked message HTML/text; missing content is a fidelity warning.",
        ],
      ),
      row(
        "templates",
        "Templates and messages",
        d.templates_count ?? 0,
        Math.max(0, d.templates_count ?? 0),
        true,
        [
          "Message/template records are preserved as source archive evidence for rebuild.",
        ],
        true,
      ),
      row(
        "automations",
        "Automations",
        d.automations_count,
        imported.automations_translated,
        true,
        [
          "Automation summaries and available blocks, goals, linked campaigns, and SMS relationships are preserved as rebuild definitions, never runtime rows.",
        ],
        true,
      ),
      row(
        "groups",
        "Assigned tags",
        d.groups_count ?? 0,
        d.groups_count ?? 0,
        true,
        [
          "Tags assigned to imported contacts map to Moosewave subscriber tags; unused tag definitions are preserved in audience schema evidence.",
        ],
      ),
      row(
        "audience_schema",
        "Audience field and tag schema",
        (d.custom_fields?.length ?? 0) + (d.groups_count ?? 0),
        (d.custom_fields?.length ?? 0) + (d.groups_count ?? 0),
        true,
        [
          "Custom-field definitions and tag definitions are preserved as source archive evidence for review.",
        ],
        true,
      ),
      row(
        "forms",
        "Forms",
        d.forms_count ?? 0,
        d.forms_count ?? 0,
        true,
        [
          "Forms are preserved as source archive evidence and must be rebuilt before switching capture points.",
        ],
        true,
      ),
      row(
        "crm",
        "CRM deals and pipelines",
        d.crm_count ?? (d.deals_count ?? 0) + (d.pipelines_count ?? 0),
        (d.deals_count ?? 0) + (d.pipelines_count ?? 0),
        true,
        [
          "Deals and pipelines are preserved as read-only source archive evidence; HubSpot or another CRM remains system of record unless explicitly rebuilt.",
        ],
        true,
      ),
      row(
        "custom_objects",
        "Custom objects",
        d.custom_objects_count ?? 0,
        d.custom_objects_count ?? 0,
        true,
        [
          "Available schemas and records are rebuild evidence; schema counts do not prove record/relationship completeness.",
        ],
        true,
      ),
      row(
        "ecommerce",
        "Ecommerce",
        d.ecommerce_count ?? 0,
        d.ecommerce_count ?? 0,
        true,
        [
          "Available orders and relations are attribution evidence; customers, connections, catalogs, and abandoned carts are not claimed complete.",
        ],
        true,
      ),
      row(
        "sms",
        "SMS broadcasts and consent",
        d.sms_campaigns_count ?? 0,
        d.sms_campaigns_count ?? 0,
        true,
        [
          "SMS broadcasts are archive-only; opt-in proof and A2P registration are required before live send.",
        ],
        true,
      ),
    ];
  }
  if (source === "hubspot") {
    const staticScopeRows = [
      ["automations", "HubSpot workflows"],
      ["campaigns", "HubSpot marketing email and archive"],
      ["templates", "HubSpot email templates"],
      ["reports", "HubSpot reports and analytics"],
      ["forms", "HubSpot forms"],
      ["landing", "HubSpot landing pages"],
      ["ecommerce", "HubSpot ecommerce"],
      ["sms", "HubSpot SMS"],
      ["custom_objects", "HubSpot custom objects"],
      ["other_crm_objects", "Other HubSpot CRM objects"],
    ].map(([resource, label]) =>
      row(
        resource,
        label,
        1,
        0,
        false,
        [
          "This unconditional source_total=1 row is a non-additive scope-review checklist, not provider inventory or proof that the surface exists or is absent.",
        ],
        true,
      ),
    );
    return [
      row(
        "subscribers",
        "Email-addressable HubSpot contacts",
        d.subscribers_count,
        imported.subscribers_imported,
        true,
        [
          "Contacts import with populated non-sensitive properties, source IDs, exact communication preferences, and conservative current-primary-email eligibility.",
        ],
      ),
      row(
        "non_email_profiles",
        "HubSpot contacts without a usable primary email",
        d.profiles_without_email_count ?? 0,
        0,
        false,
        [
          "Exact non-email contact identities remain fingerprint evidence and are never fabricated into subscribers.",
        ],
        true,
      ),
      row(
        "additional_email_identities",
        "HubSpot additional email identities",
        d.additional_email_identities_count ?? 0,
        0,
        false,
        [
          "Additional addresses are exact non-sendable evidence, not independent consent-bearing subscribers.",
        ],
        true,
      ),
      row(
        "groups",
        "Populated HubSpot contact-property values",
        d.custom_fields?.length ?? 0,
        d.custom_fields?.length ?? 0,
        true,
        [
          "Only populated non-sensitive property values map to custom fields; this row does not claim empty schema import.",
        ],
      ),
      row(
        "contact_property_definitions",
        "HubSpot contact-property definitions",
        d.groups_count ?? 0,
        0,
        false,
        [
          "Every non-sensitive definition is exact fingerprint evidence but is not materialized as destination schema.",
        ],
        true,
      ),
      row(
        "communication_preferences",
        "HubSpot email communication preferences",
        d.subscribers_count,
        imported.subscribers_imported,
        true,
        [
          "Only all-definition SUBSCRIBED contacts can be enabled; scoped/wide opt-outs disable, NOT_SPECIFIED remains unconfirmed, and consent timestamps require defensible evidence.",
        ],
      ),
      row(
        "email_eligibility",
        "HubSpot current-primary-email eligibility",
        d.subscribers_count,
        imported.subscribers_imported,
        true,
        [
          "Hard-bounce, quarantine, invalid-address, marketing-contact, double-opt-in, and legacy-opt-out restrictions block promotion. This is conservative import eligibility, not exact HubSpot sendability parity.",
        ],
      ),
      row(
        "lists",
        "HubSpot list and subscription targeting boundaries",
        d.segments_count,
        imported.segments_translated,
        true,
        [
          "This combined count includes exact list snapshots and one targeting boundary for every active email subscription definition; it is not lists-only. Exact memberships and allowlisted structural list metadata are retained, but filter predicates are deliberately not fetched or stored because they can contain sensitive literals.",
        ],
      ),
      row(
        "dynamic_list_predicates",
        "HubSpot dynamic-list rules",
        1,
        0,
        false,
        [
          "Filter predicates are deliberately not fetched or stored because they can contain sensitive property or integration-event literals. Inspect the source rule in HubSpot, then rebuild, retain, or retire it explicitly.",
        ],
        true,
      ),
      row(
        "crm",
        "HubSpot CRM",
        d.crm_count ?? d.subscribers_count,
        imported.subscribers_imported,
        true,
        [
          "HubSpot remains CRM system of record; imported is only the email-addressable contact bridge, with non-email contacts accounted separately.",
        ],
      ),
      ...staticScopeRows,
    ];
  }
  if (source === "brevo") {
    return [
      row(
        "campaigns",
        "Campaigns",
        d.campaigns_count ?? d.archive_count,
        imported.archive_imported,
        true,
        ["Sent campaigns import into the archive."],
      ),
      row("groups", "Lists", d.groups_count ?? 0, d.groups_count ?? 0, true, [
        "Brevo lists map to Moosewave tags and lists.",
      ]),
      row(
        "templates",
        "Templates",
        d.templates_count ?? 0,
        0,
        false,
        [
          "Template HTML is inventoried; editable template conversion is still manual.",
        ],
        true,
      ),
      row(
        "automations",
        "Automations",
        d.automations_count,
        0,
        false,
        ["Brevo automation workflows are surfaced in the report for rebuild."],
        true,
      ),
    ];
  }
  if (source === "beehiiv") {
    const newsletterLists = d.groups_count ?? 0;
    const providerSegments = Math.max(0, d.segments_count - newsletterLists);
    return [
      row(
        "subscribers",
        "Subscribers and subscription state",
        d.subscribers_count,
        imported.subscribers_imported,
        true,
        [
          "Subscribers retain source status, stable IDs, custom fields, acquisition data, newsletter-list membership, and premium-tier metadata. Beehiiv timestamps remain provenance rather than portable consent proof.",
        ],
      ),
      row(
        "segments",
        "Segments and newsletter lists",
        d.segments_count,
        imported.segments_translated,
        true,
        [
          "Completed memberships become frozen tag-backed snapshots; saved predicates are not exposed and must be rebuilt.",
        ],
      ),
      row(
        "segment_definitions",
        "Segment metadata and calculation state",
        providerSegments,
        providerSegments,
        true,
        [
          "Stable segment metadata and calculation state are source-preserved; executable predicates are not claimed.",
        ],
      ),
      row(
        "custom_field_schema",
        "Custom-field definitions",
        d.custom_fields.length,
        d.custom_fields.length,
        true,
        [
          "Field IDs, names, kinds, creation timestamps, and list options are source-preserved while values land on subscriber profiles.",
        ],
      ),
      row(
        "newsletter_list_definitions",
        "Newsletter-list definitions",
        newsletterLists,
        newsletterLists,
        true,
        [
          "Every discovery-bound newsletter-list definition is retained as read-only source evidence.",
        ],
      ),
      row(
        "newsletter_list_history",
        "Newsletter-list subscription-history traversals",
        newsletterLists,
        newsletterLists,
        true,
        [
          "One durable completion manifest per list proves cursor-paginated membership history was traversed, including an empty history.",
        ],
      ),
      row(
        "campaigns",
        "Sent posts/newsletters",
        d.campaigns_count ?? d.archive_count,
        imported.archive_imported,
        true,
        [
          "Only past published email/both posts import into the campaign archive; drafts, scheduled posts, and web-only posts remain source evidence.",
        ],
      ),
      row(
        "automations",
        "Automation rebuild records",
        d.automations_count,
        d.automations_count,
        true,
        [
          "Metadata, email inventory, and statistics are preserved for rebuild; no Beehiiv automation is activated as executable runtime.",
        ],
        true,
      ),
      row(
        "automation_email_inventory",
        "Automation email-inventory traversals",
        d.automations_count,
        d.automations_count,
        true,
        [
          "One durable completion manifest per automation proves its email metadata inventory was traversed, including an empty inventory.",
        ],
      ),
      row(
        "reports",
        "Post analytics",
        d.reports_count ?? d.archive_count,
        imported.archive_imported,
        true,
        [
          "Aggregate post analytics and returned click maps are preserved as archive evidence; per-reader events are not replayed.",
        ],
      ),
      row(
        "premium_memberships",
        "Premium membership metadata",
        d.paid_subs_count,
        d.paid_subs_count,
        true,
        [
          "Premium/free tier and tier-name metadata is retained on subscriber profiles and in source evidence.",
        ],
      ),
      row(
        "paid_subs",
        "Stripe billing continuity",
        d.paid_subs_count,
        0,
        false,
        [
          "Beehiiv billing objects are not migrated. Stripe customers, products, prices, subscriptions, renewals, and ownership require a separate reviewed handoff.",
        ],
        true,
      ),
      row(
        "forms",
        "Subscribe forms",
        d.forms_count || 1,
        1,
        false,
        ["Subscribe widgets/forms are not imported yet."],
        true,
      ),
      row(
        "landing",
        "Publication website",
        d.landing_pages_count || 1,
        1,
        false,
        ["Publication pages, domains, and theme settings are not imported."],
        true,
      ),
      row(
        "referrals",
        "Referrals and recommendations",
        0,
        0,
        false,
        [
          "Accessible referral milestones are source-preserved; the live referral program, recommendations, boosts, payouts, and ad-network settings need a rebuild.",
        ],
        true,
      ),
      row(
        "polls",
        "Polls and surveys",
        0,
        0,
        false,
        [
          "Accessible poll definitions and responses are source-preserved for rebuild; they are not activated as Moosewave forms.",
        ],
        true,
      ),
      row(
        "beehiiv_website_capture_rebuild",
        "Website, theme, and capture-widget rebuild",
        1,
        1,
        true,
        ["Requires explicit post-delta rebuild or retirement evidence."],
        true,
      ),
      row(
        "beehiiv_boosts_recommendations_rebuild",
        "Boosts and recommendation-network rebuild",
        1,
        1,
        true,
        ["Requires explicit post-delta rebuild or retirement evidence."],
        true,
      ),
      row(
        "beehiiv_ad_network_rebuild",
        "Beehiiv Ad Network review",
        1,
        1,
        true,
        ["Requires explicit post-delta export and ownership evidence."],
        true,
      ),
    ];
  }
  if (source === "mailerlite") {
    const savedSegments = Math.max(0, d.segments_count - (d.groups_count ?? 0));
    const nonSentCampaigns = Math.max(
      0,
      (d.campaigns_count ?? d.archive_count) - d.archive_count,
    );
    return [
      row(
        "campaigns",
        "Sent campaign archive",
        d.archive_count,
        imported.archive_imported,
        true,
        [
          "Subject, plain text when available, preview reference, sent time, aggregate totals, and every API-visible test variant are preserved. MailerLite's documented read API does not expose rendered HTML.",
        ],
        true,
      ),
      row(
        "campaign_rebuilds",
        "Draft and ready campaigns",
        nonSentCampaigns,
        imported.source_archive_by_resource?.mailerlite_campaign_rebuild ?? 0,
        true,
        [
          "Metadata is preserved; content, audience, scheduling, sender settings, and variants require rebuild verification.",
        ],
        nonSentCampaigns > 0,
      ),
      row(
        "automations",
        "Automation rebuild records",
        d.automations_count,
        imported.automations_translated,
        true,
        [
          "Trigger and step definitions are preserved for rebuild review and never activated automatically.",
        ],
        true,
      ),
      row(
        "reports",
        "Campaign reports",
        d.reports_count ?? d.archive_count,
        imported.archive_imported,
        true,
        ["Aggregate report totals are preserved."],
      ),
      row(
        "groups",
        "Groups",
        d.groups_count ?? 0,
        Math.min(imported.segments_translated, d.groups_count ?? 0),
        true,
        ["Groups map to tags and executable tag-backed segments."],
      ),
      row(
        "segments",
        "Dynamic saved segments",
        savedSegments,
        0,
        false,
        [
          "Dynamic predicates are not exposed; metadata requires rebuild review.",
        ],
        savedSegments > 0,
      ),
      row(
        "custom_field_definitions",
        "Custom-field definitions",
        d.custom_fields?.length ?? 0,
        imported.source_archive_by_resource?.mailerlite_custom_field ?? 0,
        true,
        [
          "Keys, names, and types are preserved, including definitions with no populated subscriber value.",
        ],
        true,
      ),
      row(
        "templates",
        "Reusable templates",
        1,
        0,
        false,
        [
          "The documented API has no reusable-template inventory/read endpoint.",
        ],
        true,
      ),
      row(
        "forms",
        "Forms and popups",
        d.forms_count ?? 0,
        imported.source_archive_by_resource?.mailerlite_form ?? 0,
        true,
        [
          "Metadata is source-preserved; capture UI and consent must be rebuilt.",
        ],
        true,
      ),
      row(
        "landing",
        "Sites and landing pages",
        1,
        imported.source_archive_by_resource?.[
          "parity_gap:sites_landing_pages"
        ] ?? 0,
        false,
        ["No documented inventory endpoint; manual inventory is required."],
        true,
      ),
      row(
        "ecommerce",
        "Ecommerce shops",
        d.ecommerce_count ?? 0,
        imported.source_archive_by_resource?.mailerlite_ecommerce_shop ?? 0,
        true,
        [
          "Shop metadata is preserved; catalogs, purchases, attribution, and triggers must be reconnected.",
        ],
        (d.ecommerce_count ?? 0) > 0,
      ),
    ];
  }
  if (source === "substack") {
    return [
      row(
        "subscribers",
        "Subscriber snapshot and email state",
        d.subscribers_count,
        imported.subscribers_imported,
        true,
        [
          "Source status and tier metadata are preserved, but active rows remain unconfirmed until destination consent is reviewed.",
        ],
      ),
      row(
        "consent_exclusions",
        "Consent and exclusion evidence",
        d.subscribers_count,
        0,
        false,
        ["Substack signup dates are provenance, not portable consent."],
        true,
      ),
      row(
        "premium_memberships",
        "Paid, founding, gift, and comp membership metadata",
        d.paid_subs_count,
        d.paid_subs_count,
        true,
        ["Tier metadata is preserved without claiming a billing object."],
      ),
      row(
        "campaigns",
        "Email-sent post archive",
        d.campaigns_count ?? d.archive_count,
        imported.archive_imported,
        true,
        ["Only posts with email-send evidence import into sent history."],
      ),
      row(
        "paid_subs",
        "Publication-bound billing and entitlement handoff",
        d.paid_subs_count,
        0,
        false,
        [
          "The import does not enumerate arbitrary Stripe accounts or migrate Stripe/Apple subscriptions and entitlements.",
        ],
        true,
      ),
      row(
        "reports",
        "Post stats",
        d.reports_count ?? 0,
        Math.min(imported.archive_imported, d.reports_count ?? 0),
        true,
        [
          "Aggregate delivery/open evidence is preserved without recipient identities.",
        ],
      ),
      row(
        "assets",
        "Images and files",
        1,
        1,
        true,
        [
          "Remote CDN links may remain, but portable asset ownership requires rebuild.",
        ],
        true,
      ),
      row(
        "comments",
        "Comments and reactions",
        1,
        1,
        true,
        ["Comments, likes, discussions, and recommendations are not imported."],
        true,
      ),
      row(
        "landing",
        "Publication settings",
        1,
        1,
        true,
        [
          "Theme, domain, navigation, and recommendation settings should be recreated.",
        ],
        true,
      ),
      row(
        "source_archive",
        "Export inventory and migration checklist",
        d.source_archive_count ?? 0,
        d.source_archive_count ?? 0,
        true,
        [
          "The digest, portable-file inventory, and fixed parity checklist are preserved.",
        ],
      ),
    ];
  }
  if (source === "sendy") {
    return [
      row(
        "subscribers",
        "Sendy subscribers",
        d.subscribers_count,
        imported.subscribers_imported,
        true,
        [
          "Sendy CSV exports import subscriber rows, status fields, tags, custom fields, and consent timestamps when present.",
        ],
      ),
      row(
        "segments",
        "Sendy segments",
        d.segments_count,
        imported.segments_translated,
        false,
        ["Sendy CSV exports do not include saved segment definitions."],
        true,
      ),
      row(
        "automations",
        "Automations",
        d.automations_count,
        imported.automations_translated,
        false,
        ["Sendy does not export workflows through the official API/CSV path."],
        true,
      ),
      row(
        "campaigns",
        "Campaign archive",
        d.archive_count,
        imported.archive_imported,
        false,
        [
          "Sendy subscriber CSV does not carry sent campaign content or reports.",
        ],
        true,
      ),
      row(
        "paid_subs",
        "Paid subscriptions",
        d.paid_subs_count,
        imported.paid_subs_imported,
        false,
        ["Paid subscriptions require a commerce export or Stripe connection."],
        true,
      ),
      row(
        "forms",
        "Forms and hosted pages",
        0,
        0,
        false,
        [
          "Signup forms, landing pages, and embed settings should be recreated.",
        ],
        true,
      ),
    ];
  }
  return [
    row(
      "subscribers",
      "Subscribers",
      d.subscribers_count,
      imported.subscribers_imported,
      true,
      [
        "CSV imports subscriber rows, tags, custom fields, and consent timestamps when present.",
      ],
    ),
    row(
      "segments",
      "Segments",
      d.segments_count,
      imported.segments_translated,
      false,
      ["Generic CSV has no saved-segment model."],
      true,
    ),
    row(
      "automations",
      "Automations",
      d.automations_count,
      imported.automations_translated,
      false,
      ["Generic CSV does not contain workflows."],
      true,
    ),
    row(
      "campaigns",
      "Campaign archive",
      d.archive_count,
      imported.archive_imported,
      false,
      ["Generic CSV does not carry sent campaign content or reports."],
      true,
    ),
    row(
      "paid_subs",
      "Paid subscriptions",
      d.paid_subs_count,
      imported.paid_subs_imported,
      false,
      [
        "Paid subscriptions require a source-specific export or Stripe connection.",
      ],
      true,
    ),
    row(
      "forms",
      "Forms and landing pages",
      0,
      0,
      false,
      [
        "Forms, landing pages, and embeds are not represented in a contact CSV.",
      ],
      true,
    ),
  ];
}

function statusFor(
  sourceTotal: number,
  imported: number,
  supported: boolean,
  forceGap: boolean,
  resource = "",
):
  | "imported_runtime"
  | "partial_runtime"
  | "preserved_for_rebuild"
  | "manual_rebuild_required"
  | "not_supported"
  | "not_detected" {
  if (!supported) {
    if (sourceTotal === 0 && !forceGap) return "not_detected";
    return forceGap ? "manual_rebuild_required" : "not_supported";
  }
  if (forceGap && rebuildTaskResource(resource)) {
    if (imported <= 0 || (sourceTotal > 0 && imported < sourceTotal)) {
      return "manual_rebuild_required";
    }
    return "preserved_for_rebuild";
  }
  if (sourceTotal === 0) return "not_detected";
  if (imported >= sourceTotal && !forceGap) return "imported_runtime";
  if (imported > 0) return "partial_runtime";
  return forceGap ? "manual_rebuild_required" : "partial_runtime";
}

function rebuildTaskResource(resource: string): boolean {
  return new Set([
    "assets",
    "automations",
    "audience_schema",
    "channel_dependencies",
    "consent_exclusions",
    "comments",
    "connected_sites",
    "content",
    "cdp",
    "crm",
    "custom_objects",
    "deliverability",
    "ads",
    "developer_platform",
    "ecommerce",
    "forms",
    "landing",
    "marketplace",
    "non_email_contacts",
    "omni_channels",
    "polls",
    "referrals",
    "reviews",
    "service",
    "source_archive",
    "sms",
    "structured_templates",
    "subscription_topics",
    "surveys",
    "templates",
    "transactional",
    "workflow_definitions",
    "beehiiv_ad_network_rebuild",
    "beehiiv_boosts_recommendations_rebuild",
    "beehiiv_website_capture_rebuild",
    "multi_email_profiles",
    "ecosystem",
  ]).has(resource);
}

function sourceWarnings(source: SourcePlatform): string[] {
  switch (source) {
    case "mailchimp":
      return [
        "Two automations use 'goal tracking' which Moosewave does not support.",
      ];
    case "activecampaign":
      return [
        "ActiveCampaign saved segments, automation definitions, templates, forms, CRM, custom objects, ecommerce, SMS broadcasts, phone-only contacts, and incomplete consent/exclusion evidence remain rebuild/review surfaces.",
      ];
    case "hubspot":
      return [
        "HubSpot remains CRM system of record. The final full snapshot is authoritative because changed-contact polling does not cover every list/preference-only change, deletion, or contact that loses email.",
      ];
    case "convertkit":
      return [
        "Kit forms, landing pages, commerce products, and incentive downloads are flagged as manual rebuild items.",
      ];
    case "substack":
      return [
        "Substack signup dates are provenance and active rows remain unconfirmed. Paid tiers are metadata only; Stripe/Apple billing, comments/reactions, Notes/restacks, chat, recommendations/referrals, automations, surveys, media/assets, publication settings, engagement history, and integrations require separate handoff or rebuild.",
      ];
    case "beehiiv":
      return [
        "Beehiiv automations and dynamic segment predicates require rebuild; accessible referral milestones and polls are source evidence, while recommendations, boosts, billing objects, and website settings require a separate handoff.",
      ];
    case "klaviyo":
      return [
        "Klaviyo's stable Get Profiles response exposes the primary email identity, not secondary email identifiers or their independent per-address consent/suppression state. Automatic profile-identity and consent parity is therefore unavailable; reconcile the mandatory source-archive review record with a provider export or retained Klaviyo access. Profile reads request predictive_analytics under its stricter 10 requests/second and 150 requests/minute tier. Nullable list/segment names receive deterministic Klaviyo list <id> or Klaviyo segment <id> fallbacks. List/segment counts and tags are the exact enumerated send-targetable projection after validated list-level suppressions are excluded, not raw Klaviyo membership; the raw count is not exposed separately. Incremental replay fails closed if a stable profile ID changes email while its prior source-owned destination remains active; the full final snapshot must materialize the new address and disable the old address before replay resumes. Only sent Klaviyo email campaigns materialize as email archive rows; sent SMS and push remain non-executable source-archive evidence. Draft campaign-message definitions and flow definitions may be null and remain explicitly incomplete rebuild evidence; campaign tags preserve provider IDs only, not resolved names. Dynamic segment predicates and flows require rebuild review. Eight static source-archive product-area rows are emitted unconditionally as checklist records; source_total=1 means one checklist record and does not prove source inventory. Reporting metrics, non-email-only profiles, commerce/service configuration, deliverability setup, and partner integrations are not activated as Moosewave runtime resources by this import.",
      ];
    case "customerio":
      return [
        "Customer.io traversal is bound to one US/EU workspace and immutable cio_id identities. Profiles without email are excluded explicitly; duplicate profiles may share one email. Global unsubscribe, channel/topic preferences, and ESP suppressions require reconciliation. Segment memberships are frozen snapshots, automations are rebuild-only, only eligible sent email one-time sends become campaign archive rows, and non-email channels, transactional messages, API broadcasts, objects/relationships, content assets, sender/integration settings, reporting webhooks, and GDPR-suppressed identifiers remain source evidence or manual handoff work.",
      ];
    case "mailerlite":
      return [
        "MailerLite custom-field definitions and draft/ready campaigns are source-preserved alongside form and shop metadata. Groups become tag-backed segments. Saved-segment predicates and executable automation/message-body contracts are not exposed safely, so both remain rebuild evidence. Sent campaigns preserve metadata, plain text, email variants, preview references, and aggregate totals, but not rendered HTML. Live capture, sites, templates, and commerce behavior must be rebuilt or reconnected.",
      ];
    case "brevo":
      return [
        "Brevo template conversion and automation rebuilds are surfaced in the parity report.",
      ];
    case "sendy":
      return [
        "Sendy uses the CSV export path because the official API does not expose a complete subscriber export endpoint.",
      ];
    case "csv":
      return [
        "CSV imports include subscribers only; segments and automations are not present in the file.",
      ];
    default:
      return [];
  }
}

const MIGRATION_MOCK_SOURCES: readonly SourcePlatform[] =
  MIGRATION_SOURCE_PLATFORMS;

function isSourcePlatform(s: string): s is SourcePlatform {
  return MIGRATION_MOCK_SOURCES.includes(s as SourcePlatform);
}

const JOBS = new Map<string, MigrationJob>();
const MOCK_GENERIC_SOURCE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MOCK_ACTIVE_CAMPAIGN_SOURCE_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function newJobID(source: SourcePlatform): string {
  return `job_${source.replace(/[^a-z0-9]+/gi, "_")}_${Math.random().toString(36).slice(2, 10)}`;
}

function sourceFromMockJobID(jobId: string): SourcePlatform | null {
  const raw = jobId.replace(/^job_/, "");
  const sourcesByLongestSegment = [...MIGRATION_MOCK_SOURCES].sort(
    (a, b) =>
      b.replace(/[^a-z0-9]+/gi, "_").length -
      a.replace(/[^a-z0-9]+/gi, "_").length,
  );
  for (const source of sourcesByLongestSegment) {
    const segment = source.replace(/[^a-z0-9]+/gi, "_");
    if (raw === segment || raw.startsWith(`${segment}_`)) return source;
  }
  return null;
}

function mockSourceSessionExpiresAt(source: SourcePlatform): string {
  const ttl =
    source === "activecampaign" ||
    source === "hubspot" ||
    source === "beehiiv" ||
    source === "klaviyo" ||
    source === "customerio"
      ? MOCK_ACTIVE_CAMPAIGN_SOURCE_SESSION_TTL_MS
      : MOCK_GENERIC_SOURCE_SESSION_TTL_MS;
  return new Date(Date.now() + ttl).toISOString();
}

export function mockStartJob(
  source: SourcePlatform,
  status: MigrationStatus,
): MigrationJob {
  const id = newJobID(source);
  const job: MigrationJob = {
    id,
    tenant_id: "tenant_local",
    source,
    status,
    progress:
      status === "importing"
        ? {
            ...emptyProgress(),
            subscribers_total: 12_437,
            segments_total: 7,
            automations_total: 3,
            archive_total: 142,
            paid_subs_total: 312,
          }
        : emptyProgress(),
    cursor: {},
    started_at: new Date().toISOString(),
    completed_at: null,
    rollback_until: null,
    source_session_expires_at: mockSourceSessionExpiresAt(source),
    selected_audience_ids:
      source === "mailchimp"
        ? ["list_customers", "list_events", "list_newsletter"]
        : undefined,
    verification_report:
      status === "awaiting_confirmation" ? mockVerification(source) : null,
    error: null,
  };
  JOBS.set(id, job);
  return job;
}

// ─── Rollback mocks ──────────────────────────────────────────────────────
//
// Mock rollback "runs" are advanced on each status poll, mirroring the real
// engine's stage progression: archive → automations → segments → subscribers.
// This gives the UI's progress bar a believable feel during local dev.

interface MockRollback {
  job_id: string;
  status: RollbackStatus;
  step: number; // 0..4
}

const ROLLBACKS = new Map<string, MockRollback>();

export function mockStartRollback(jobId: string): {
  job_id: string;
  state: string;
} {
  const job = JOBS.get(jobId);
  const subs = job?.verification_report?.subscribers_imported ?? 12_400;
  const segs = job?.verification_report?.segments_translated ?? 7;
  const autos = job?.verification_report?.automations_translated ?? 3;
  const arch = job?.verification_report?.archive_imported ?? 142;

  const r: MockRollback = {
    job_id: jobId,
    step: 0,
    status: {
      state: "running",
      archive_deleted: 0,
      archive_total: arch,
      automations_deleted: 0,
      automations_total: autos,
      segments_deleted: 0,
      segments_total: segs,
      subscribers_deleted: 0,
      subscribers_total: subs,
      started_at: new Date().toISOString(),
    },
  };
  ROLLBACKS.set(jobId, r);
  return { job_id: jobId, state: "running" };
}

export function mockRollbackStatus(jobId: string): RollbackStatus {
  const r = ROLLBACKS.get(jobId);
  if (!r) {
    // If the UI polls before kickoff (HMR weirdness), synthesize a fresh one.
    mockStartRollback(jobId);
    return ROLLBACKS.get(jobId)!.status;
  }
  // Advance one stage per poll. Each stage zooms to completion in three ticks.
  const s = r.status;
  const tick = () => {
    if (s.archive_deleted < s.archive_total) {
      s.archive_deleted = Math.min(
        s.archive_total,
        s.archive_deleted + Math.ceil(s.archive_total / 3),
      );
    } else if (s.automations_deleted < s.automations_total) {
      s.automations_deleted = Math.min(
        s.automations_total,
        s.automations_deleted + 1,
      );
    } else if (s.segments_deleted < s.segments_total) {
      s.segments_deleted = Math.min(
        s.segments_total,
        s.segments_deleted + Math.ceil(s.segments_total / 2),
      );
    } else if (s.subscribers_deleted < s.subscribers_total) {
      s.subscribers_deleted = Math.min(
        s.subscribers_total,
        s.subscribers_deleted + Math.ceil(s.subscribers_total / 4),
      );
    } else {
      s.state = "completed";
      s.completed_at = new Date().toISOString();
      // Reflect rollback into the job snapshot too.
      const job = JOBS.get(jobId);
      if (job) {
        JOBS.set(jobId, {
          ...job,
          status: "rolled_back",
          rollback_until: null,
        });
      }
    }
  };
  tick();
  return { ...s };
}

// ─── Audit log mock ──────────────────────────────────────────────────────
//
// Five recent audit_log entries scoped to a migration_id. Used by the
// detail page's "Recent activity" preview.
export function mockAuditLog(jobId: string): AuditEntry[] {
  const base = Date.now();
  return [
    {
      id: `aud_${jobId}_5`,
      timestamp: new Date(base - 60_000).toISOString(),
      event: "migration.completed",
      actor: "system",
      fields: { job_id: jobId, subscribers: 12_400 },
    },
    {
      id: `aud_${jobId}_4`,
      timestamp: new Date(base - 90_000).toISOString(),
      event: "migration.archive_persisted",
      actor: "system",
      fields: { count: 142 },
    },
    {
      id: `aud_${jobId}_3`,
      timestamp: new Date(base - 240_000).toISOString(),
      event: "migration.automation_persisted",
      actor: "system",
      fields: { count: 3 },
    },
    {
      id: `aud_${jobId}_2`,
      timestamp: new Date(base - 480_000).toISOString(),
      event: "migration.segment_compiled",
      actor: "system",
      fields: { count: 7 },
    },
    {
      id: `aud_${jobId}_1`,
      timestamp: new Date(base - 900_000).toISOString(),
      event: "migration.dry_run_started",
      actor: "user@example.com",
      fields: { job_id: jobId },
    },
  ];
}

export function mockGetJob(jobId: string): MigrationJob {
  const existing = JOBS.get(jobId);
  if (!existing) {
    // Synthesize a fresh importing job if we've lost state (e.g. HMR).
    const job = mockStartJob(
      sourceFromMockJobID(jobId) ?? "mailchimp",
      "importing",
    );
    JOBS.set(jobId, { ...job, id: jobId });
    return JOBS.get(jobId) as MigrationJob;
  }
  // Advance progress on each poll for "importing" jobs.
  if (existing.status === "importing") {
    const p = existing.progress;
    const next: MigrationProgress = {
      ...p,
      subscribers_done: Math.min(
        p.subscribers_total,
        p.subscribers_done + Math.ceil(p.subscribers_total * 0.12),
      ),
      segments_done: Math.min(p.segments_total, p.segments_done + 1),
      automations_done: Math.min(p.automations_total, p.automations_done + 1),
      archive_done: Math.min(
        p.archive_total,
        p.archive_done + Math.ceil(p.archive_total * 0.15),
      ),
      paid_subs_done: Math.min(
        p.paid_subs_total,
        p.paid_subs_done + Math.ceil((p.paid_subs_total || 1) * 0.2),
      ),
    };
    const allDone =
      next.subscribers_done >= next.subscribers_total &&
      next.segments_done >= next.segments_total &&
      next.automations_done >= next.automations_total &&
      next.archive_done >= next.archive_total &&
      next.paid_subs_done >= next.paid_subs_total;
    const updated: MigrationJob = {
      ...existing,
      progress: next,
      status: allDone ? "completed" : "importing",
      completed_at: allDone ? new Date().toISOString() : null,
      rollback_until: allDone
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        : null,
      verification_report: allDone
        ? mockVerification(existing.source)
        : existing.verification_report,
    };
    JOBS.set(jobId, updated);
    return updated;
  }
  return existing;
}

export function mockListJobs(): MigrationJob[] {
  return Array.from(JOBS.values()).sort(
    (a, b) =>
      new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
  );
}
