import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { ConsoleMessage, Page, Route, TestInfo } from "@playwright/test";

import { expect, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export const FIXED_TIME = "2026-08-09T09:30:00.000Z";
export const HEALTHY_SLUG = "mailchimp";
export const ATTENTION_SLUG = "zendesk";
export const READY_SLUG = "stripe";
export const PLANNED_SLUG = "braze";
export const WEBHOOK_SLUG = "webhook-relay";
export const NATIVE_CRM_SLUG = "hubspot";
export const HEALTHY_CONNECTION_ID = "connection-mailchimp-primary";
export const READY_RECIPE_ID = "recipe-mailchimp-welcome";
export const PLANNED_RECIPE_ID = "recipe-braze-events";

export type Theme = "dark" | "light";
export type IntegrationsResource =
  | "catalog"
  | "connections"
  | "coverage"
  | "stacks"
  | "readiness"
  | "recipes";

export interface IntegrationsRequestEvidence {
  method: string;
  pathname: string;
  search: string;
  body: string | null;
}

export interface ExpectedIntegrationMutation {
  target: string;
  action:
    | "recipe/prepare"
    | "connect/start"
    | "connect/callback"
    | "oauth/availability"
    | "oauth/start"
    | "oauth/callback"
    | "sync"
    | "backfill"
    | "pause"
    | "disconnect"
    | "provider-cleanup/acknowledge"
    | "roadmap";
}

export interface VerifiedIntegrationMutation
  extends ExpectedIntegrationMutation, IntegrationsRequestEvidence {
  responseStatus: "delegated";
}

export interface IntegrationsHarness {
  requests: IntegrationsRequestEvidence[];
  mutations: VerifiedIntegrationMutation[];
  expectedMutations: ExpectedIntegrationMutation[];
  unexpected: string[];
}

export interface OpenIntegrationsOptions {
  theme?: Theme;
  width?: number;
  height?: number;
  failResources?: readonly IntegrationsResource[];
  crmRegistryFailuresBeforeSuccess?: number;
}

type BootApp = (page: Page) => Promise<void>;
type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

const CATALOG_ITEMS = [
  {
    slug: HEALTHY_SLUG,
    name: "Mailchimp",
    category: "marketing",
    badge: "partner",
    runtime_status: "available",
    summary:
      "Delegated audience and campaign sync with an observable setup handoff.",
    capabilities: ["audience_sync", "campaign_events", "oauth"],
    docs_url: "https://mailchimp.com/developer/marketing/guides/quick-start/",
    setup_path: "/migrations",
    native: false,
    featured: true,
    phase: "1",
    sources: ["integrations_catalog", "migration"],
  },
  {
    slug: ATTENTION_SLUG,
    name: "Zendesk",
    category: "support",
    badge: "partner",
    runtime_status: "partial",
    summary:
      "Support events are connected; credential renewal needs operator review.",
    capabilities: ["tickets", "users", "webhooks"],
    docs_url: "https://developer.zendesk.com/documentation/",
    setup_path: "/settings/integrations",
    native: false,
    phase: "2",
    sources: ["integrations_catalog", "support_bridge"],
  },
  {
    slug: READY_SLUG,
    name: "Stripe",
    category: "payments",
    badge: "partner",
    runtime_status: "delegated",
    summary:
      "A delegated payment-event path is ready to configure in the owning surface.",
    capabilities: ["payments", "subscriptions", "events"],
    docs_url: "https://docs.stripe.com/webhooks",
    setup_path: "/webhooks",
    native: false,
    featured: true,
    phase: "2",
    sources: ["integrations_catalog", "webhook_bridge"],
  },
  {
    slug: PLANNED_SLUG,
    name: "Braze",
    category: "messaging",
    badge: "planned",
    runtime_status: "planned",
    summary:
      "Roadmap entry only; no production connector or implied setup action.",
    capabilities: ["events", "audiences", "messaging"],
    docs_url: "https://www.braze.com/docs/",
    native: false,
    phase: "4",
    sources: ["integrations_catalog", "roadmap"],
  },
  {
    slug: WEBHOOK_SLUG,
    name: "Moosewave Webhook Relay",
    category: "developer",
    badge: "webhook",
    runtime_status: "available",
    summary:
      "A scoped server-side relay for signed lifecycle and profile events.",
    capabilities: ["signed_events", "delivery_logs", "replay"],
    docs_url: "https://docs.postwave.example/integrations/webhook-relay",
    setup_path: "/webhooks",
    native: false,
    phase: "1",
    sources: ["integrations_catalog", "outbound_webhooks"],
  },
  {
    slug: NATIVE_CRM_SLUG,
    name: "HubSpot",
    category: "crm",
    badge: "native",
    runtime_status: "available",
    summary:
      "A native managed CRM import path with vault-referenced credentials and server-side verification.",
    capabilities: ["contacts", "companies", "deals"],
    docs_url:
      "https://developers.hubspot.com/docs/guides/apps/private-apps/overview",
    setup_path: "/settings/integrations",
    native: true,
    featured: true,
    phase: "1",
    sources: ["integrations_catalog", "crm"],
  },
] as const;

const CATALOG = {
  schema_version: "2026-08-99p9",
  target_public_entries: 6,
  target_native_managed: 2,
  honest_badges: ["native", "partner", "planned", "webhook"],
  categories: [
    { key: "marketing", label: "Marketing platforms" },
    { key: "support", label: "Customer support" },
    { key: "payments", label: "Payments" },
    { key: "messaging", label: "Messaging" },
    { key: "developer", label: "Developer tools" },
    { key: "crm", label: "CRM" },
  ],
  capabilities: [
    "audience_sync",
    "campaign_events",
    "oauth",
    "tickets",
    "users",
    "webhooks",
    "payments",
    "subscriptions",
    "events",
    "audiences",
    "messaging",
    "signed_events",
    "delivery_logs",
    "replay",
    "contacts",
    "companies",
    "deals",
  ],
  items: CATALOG_ITEMS,
  counts: {
    total: 6,
    "badge:native": 1,
    "badge:partner": 3,
    "badge:planned": 1,
    "badge:webhook": 1,
    "runtime:available": 3,
    "runtime:partial": 1,
    "runtime:delegated": 1,
    "runtime:planned": 1,
  },
} as const;

const CONNECTIONS = [
  {
    slug: HEALTHY_SLUG,
    name: "Mailchimp",
    category: "marketing",
    badge: "partner",
    runtime_status: "available",
    connected: true,
    status: "active",
    count: 1,
    primary_connection_id: HEALTHY_CONNECTION_ID,
    connection_ids: [HEALTHY_CONNECTION_ID],
    last_sync_at: "2026-08-09T09:12:00.000Z",
    manage_path: "/migrations",
    source: "migration_bridge",
    health_state: "healthy",
    health_message: "Latest audience checkpoint completed without errors.",
  },
  {
    slug: ATTENTION_SLUG,
    name: "Zendesk",
    category: "support",
    badge: "partner",
    runtime_status: "partial",
    connected: true,
    status: "error",
    count: 1,
    primary_connection_id: "connection-zendesk-primary",
    connection_ids: ["connection-zendesk-primary"],
    last_sync_at: "2026-08-08T18:20:00.000Z",
    last_error: "Credential reference expired; renew it in the owning surface.",
    manage_path: "/settings/integrations",
    source: "support_bridge",
    health_state: "needs_attention",
    health_message:
      "Inbound ticket events are paused pending credential review.",
  },
  {
    slug: READY_SLUG,
    name: "Stripe",
    category: "payments",
    badge: "partner",
    runtime_status: "delegated",
    connected: false,
    status: "not_configured",
    count: 0,
    connection_ids: [],
    last_sync_at: null,
    manage_path: "/webhooks",
    source: "webhook_bridge",
    health_state: "ready_to_configure",
    health_message: "A reviewed delegated setup path is available.",
  },
  {
    slug: PLANNED_SLUG,
    name: "Braze",
    category: "messaging",
    badge: "planned",
    runtime_status: "planned",
    connected: false,
    status: "planned",
    count: 0,
    connection_ids: [],
    last_sync_at: null,
    source: "roadmap",
    health_state: "planned",
    health_message: "No runtime connector is claimed for this roadmap entry.",
  },
] as const;

const CONNECTIONS_RESPONSE = {
  items: CONNECTIONS,
  summary: {
    total: 4,
    connected: 2,
    "health:healthy": 1,
    "health:needs_attention": 1,
    "health:ready_to_configure": 1,
    "health:planned": 1,
  },
  returned: CONNECTIONS.length,
} as const;

const COVERAGE = {
  schema_version: "2026-08-99p9",
  target_public_entries: 6,
  target_native_managed: 2,
  target_native_verified: 2,
  public_entries: 6,
  native_managed: 1,
  native_verified: 1,
  native_partial: 1,
  native_delegated: 1,
  public_gap: 0,
  native_gap: 1,
  native_verification_gap: 1,
  public_parity: true,
  native_parity: false,
  native_verification_parity: false,
  bridge_ready: 4,
  planned: 1,
  available_recipes: 1,
  generated_recipes: 2,
  badge_counts: { native: 1, partner: 3, planned: 1, webhook: 1 },
  phase_counts: { "1": 3, "2": 2, "4": 1 },
  maturity_counts: {
    verified_hybrid_ready: 1,
    foundation_hybrid_ready: 1,
    bridge_ready: 3,
    planned_only: 1,
  },
  categories: CATALOG.categories.map((category, index) => ({
    key: category.key,
    label: category.label,
    total: 1,
    native_managed: category.key === "crm" ? 1 : 0,
    native_verified: category.key === "crm" ? 1 : 0,
    native_partial: index === 1 ? 1 : 0,
    native_delegated: index === 2 ? 1 : 0,
    bridge_ready: index < 3 || category.key === "crm" ? 1 : 0,
    planned: index === 3 ? 1 : 0,
    available_recipes: index === 0 ? 1 : 0,
    maturity:
      category.key === "crm"
        ? "verified_hybrid_ready"
        : index === 1
          ? "foundation_hybrid_ready"
          : index === 3
            ? "planned_only"
            : "bridge_ready",
  })),
  priority_gaps: [
    {
      slug: PLANNED_SLUG,
      name: "Braze",
      category: "messaging",
      phase: "4",
      current_badge: "planned",
      runtime_status: "planned",
      bridge_available: false,
      reason: "Two reference stacks still lack a verified messaging path.",
    },
    {
      slug: ATTENTION_SLUG,
      name: "Zendesk",
      category: "support",
      phase: "2",
      current_badge: "partner",
      runtime_status: "partial",
      bridge_available: true,
      reason: "Credential renewal and API certification remain open.",
    },
  ],
} as const;

const READINESS = {
  schema_version: "2026-08-99p9",
  ready: false,
  marketable_public_claim: false,
  public_claim:
    "Catalog parity is verified, but support health and native certification remain release boundaries.",
  public_entries: 6,
  target_public_entries: 6,
  native_managed: 1,
  target_native_managed: 2,
  native_verified: 1,
  target_native_verified: 2,
  native_partial: 1,
  native_delegated: 1,
  bridge_ready: 4,
  available_recipes: 1,
  public_parity: true,
  native_parity: false,
  native_verification_parity: false,
  checks: [
    {
      key: "catalog_parity",
      label: "Truth-labelled catalog parity",
      state: "pass",
      severity: "ok",
      count: 6,
      message: "Every public entry has an explicit ownership badge.",
    },
    {
      key: "connection_health",
      label: "Connected provider health",
      state: "fail",
      severity: "blocker",
      count: 1,
      message: "One connected provider needs credential remediation.",
    },
  ],
  issues: [
    {
      key: "credential_expired",
      severity: "blocker",
      slug: ATTENTION_SLUG,
      name: "Zendesk",
      category: "support",
      message: "The recorded credential reference can no longer sync.",
      remediation: "Renew the exact reference, then re-run provider health.",
    },
  ],
  issue_counts: { "severity:blocker": 1, total: 1 },
  recommendations: [
    "Resolve the Zendesk credential boundary before a client demonstration.",
    "Keep Braze labelled as roadmap-only until a verified runtime exists.",
  ],
} as const;

const STACKS = {
  schema_version: "2026-08-99p9",
  target_coverage_pct: 90,
  covered_pct: 75,
  covered_stacks: 1,
  total_stacks: 2,
  summary: { "status:covered": 1, "status:partial": 1, "status:gap": 0 },
  stacks: [
    {
      key: "newsletter-growth",
      name: "Newsletter growth stack",
      segment: "creator_business",
      summary:
        "Audience acquisition and campaign delivery with a reviewed bridge path.",
      status: "covered",
      coverage_pct: 100,
      required_covered: 2,
      required_total: 2,
      optional_covered: 1,
      optional_total: 1,
      native_managed: 0,
      bridge_ready: 2,
      planned_gaps: [],
      components: [
        {
          slug: HEALTHY_SLUG,
          name: "Mailchimp",
          role: "campaign_delivery",
          required: true,
          category: "marketing",
          badge: "partner",
          runtime_status: "available",
          available: true,
          native_managed: false,
          bridge_available: true,
          setup_path: "/migrations",
          reason: "Delegated migration and sync path verified.",
        },
        {
          slug: WEBHOOK_SLUG,
          name: "Moosewave Webhook Relay",
          role: "event_delivery",
          required: true,
          category: "developer",
          badge: "webhook",
          runtime_status: "available",
          available: true,
          native_managed: false,
          bridge_available: true,
          setup_path: "/webhooks",
          reason: "Signed event delivery is available.",
        },
      ],
      next_actions: [
        "Verify the customer-specific audience scope before migration.",
      ],
    },
    {
      key: "support-commerce",
      name: "Support and payments stack",
      segment: "commerce_team",
      summary:
        "Payment events are ready while the support credential remains degraded.",
      status: "partial",
      coverage_pct: 50,
      required_covered: 1,
      required_total: 2,
      optional_covered: 0,
      optional_total: 1,
      native_managed: 0,
      bridge_ready: 1,
      planned_gaps: [PLANNED_SLUG],
      components: [
        {
          slug: READY_SLUG,
          name: "Stripe",
          role: "payment_events",
          required: true,
          category: "payments",
          badge: "partner",
          runtime_status: "delegated",
          available: true,
          native_managed: false,
          bridge_available: true,
          setup_path: "/webhooks",
          reason: "Delegated payment event path is ready.",
        },
        {
          slug: ATTENTION_SLUG,
          name: "Zendesk",
          role: "customer_support",
          required: true,
          category: "support",
          badge: "partner",
          runtime_status: "partial",
          available: false,
          native_managed: false,
          bridge_available: true,
          setup_path: "/settings/integrations",
          reason: "Renew the credential before claiming coverage.",
        },
        {
          slug: PLANNED_SLUG,
          name: "Braze",
          role: "lifecycle_messaging",
          required: false,
          category: "messaging",
          badge: "planned",
          runtime_status: "planned",
          available: false,
          native_managed: false,
          bridge_available: false,
          reason: "Roadmap-only component.",
        },
      ],
      next_actions: [
        "Renew Zendesk credentials.",
        "Keep Braze outside production claims.",
      ],
    },
  ],
  highest_impact_gaps: [
    {
      slug: PLANNED_SLUG,
      name: "Braze",
      stacks: 2,
      required_count: 2,
      reason: "Messaging coverage would improve two reference architectures.",
    },
  ],
  newsletter_commerce_ok: false,
} as const;

const READY_RECIPE = {
  id: READY_RECIPE_ID,
  name: "Mailchimp audience to welcome journey",
  provider: "Moosewave Bridge",
  source_slug: HEALTHY_SLUG,
  target_slug: WEBHOOK_SLUG,
  summary:
    "Prepare a reviewed audience handoff without creating or enabling automation.",
  badge: "webhook",
  available: true,
  estimated_minutes: 18,
  setup_path: "/webhooks",
  docs_url: "https://docs.postwave.example/recipes/mailchimp-welcome",
  capabilities: ["audience_sync", "signed_events", "welcome_journey"],
  steps: [
    {
      title: "Verify audience scope",
      description: "Choose the exact Mailchimp audience and consent boundary.",
      action: "Open migration workspace",
      path: "/migrations",
      required_fields: ["audience_id", "consent_basis"],
    },
    {
      title: "Review relay destination",
      description: "Confirm the signed event destination before activation.",
      action: "Open webhook workspace",
      path: "/webhooks",
      required_fields: ["destination_id"],
    },
  ],
  blueprint: {
    trigger: "audience_member_synced",
    destination: "Moosewave Webhook Relay",
    postwave_surface: "Welcome journey",
    required_scopes: ["audiences:read", "subscribers:write"],
    required_secrets: ["mailchimp_oauth_reference"],
    events: ["audience.member.created", "audience.member.updated"],
    field_mappings: [
      {
        source: "merge_fields.EMAIL",
        target: "subscriber.email",
        required: true,
        description: "Verified email identity for the reviewed audience.",
      },
      {
        source: "merge_fields.FNAME",
        target: "subscriber.first_name",
        required: false,
        description: "Optional display-name enrichment.",
      },
    ],
    sample_payload: {
      event: "audience.member.created",
      subscriber: { email: "redacted@example.invalid", consent: "explicit" },
    },
    data_handling: [
      "Consent state is preserved",
      "Secret values remain in the credential vault",
      "No automation is created during preparation",
    ],
  },
} as const;

const PLANNED_RECIPE = {
  id: PLANNED_RECIPE_ID,
  name: "Braze events to Moosewave profiles",
  provider: "Roadmap",
  source_slug: PLANNED_SLUG,
  target_slug: WEBHOOK_SLUG,
  summary: "Blueprint evidence only; the runtime path is not available.",
  badge: "planned",
  available: false,
  estimated_minutes: 0,
  docs_url: "https://docs.postwave.example/roadmap/braze",
  capabilities: ["events", "profiles"],
  steps: [
    {
      title: "Track certification",
      description: "Wait for an explicit verified runtime milestone.",
    },
  ],
  blueprint: {
    trigger: "braze_event_received",
    destination: "Moosewave profiles",
    postwave_surface: "Profile timeline",
    required_scopes: ["users.track"],
    required_secrets: ["braze_api_reference"],
    events: ["custom_event"],
    field_mappings: [],
    sample_payload: { event: "roadmap_only" },
    data_handling: ["No production processing is claimed"],
  },
} as const;

const RECIPES_RESPONSE = {
  items: [READY_RECIPE, PLANNED_RECIPE],
  summary: { total: 2, available: 1, planned: 1 },
} as const;

const CRM_PROVIDER_REGISTRY = {
  items: [
    {
      provider: NATIVE_CRM_SLUG,
      name: "HubSpot",
      category: "crm",
      auth_mode: "private_app_reference",
      managed: true,
      runtime_status: "available",
      sync_model: "incremental_import",
      verification_mode: "server_side",
      capabilities: ["contacts", "companies", "deals"],
      required_settings: [
        {
          key: "portal_id",
          label: "Portal ID",
          required: true,
          help: "The exact HubSpot portal that owns the reviewed objects.",
        },
        {
          key: "credentials_ref",
          label: "Credential reference",
          required: true,
          secret: true,
          help: "Reference an existing private-app credential in the secure vault.",
        },
      ],
      optional_settings: [
        {
          key: "pipeline_id",
          label: "Pipeline ID",
          required: false,
          help: "Optional pipeline scope for deal imports.",
        },
      ],
      scopes: [
        "crm.objects.contacts.read",
        "crm.objects.companies.read",
        "crm.objects.deals.read",
      ],
      sync_objects: ["contacts", "companies", "deals"],
      webhook_topics: [],
      docs_url:
        "https://developers.hubspot.com/docs/guides/apps/private-apps/overview",
    },
  ],
} as const;

function itemForSlug(slug: string) {
  return CATALOG_ITEMS.find((item) => item.slug === slug);
}

function connectionForSlug(slug: string) {
  const item = itemForSlug(slug);
  if (!item) return undefined;
  return (
    CONNECTIONS.find((connection) => connection.slug === slug) ?? {
      slug: item.slug,
      name: item.name,
      category: item.category,
      badge: item.badge,
      runtime_status: item.runtime_status,
      connected: false,
      status: item.runtime_status === "planned" ? "planned" : "not_configured",
      count: 0,
      connection_ids: [],
      last_sync_at: null,
      source: item.sources[1] ?? "integrations_catalog",
      health_state:
        item.runtime_status === "planned" ? "planned" : "ready_to_configure",
      health_message:
        item.runtime_status === "planned"
          ? "No runtime connector is claimed for this roadmap entry."
          : "The setup path is available but no account is connected.",
    }
  );
}

function recipesForSlug(slug: string) {
  return RECIPES_RESPONSE.items.filter(
    (recipe) => recipe.source_slug === slug || recipe.target_slug === slug,
  );
}

function lifecycleActionsForSlug(slug: string) {
  const connection = connectionForSlug(slug);
  if (slug === PLANNED_SLUG) return ["roadmap"] as const;
  if (connection?.connected) {
    return ["sync", "backfill", "pause", "disconnect"] as const;
  }
  return ["connect/start"] as const;
}

function healthForSlug(slug: string) {
  const item = itemForSlug(slug);
  const connection = connectionForSlug(slug);
  if (!item || !connection) return undefined;
  const healthy = connection.health_state === "healthy";
  const planned = connection.health_state === "planned";
  return {
    state: connection.health_state,
    severity: healthy ? "ok" : planned ? "info" : "warning",
    message: connection.health_message,
    monitoring_surface: "Integration health workspace",
    docs_url: item.docs_url,
    checks: [
      {
        key: "provider_reachability",
        label: "Provider reachability",
        state: healthy ? "ok" : planned ? "planned" : "warning",
        message: healthy
          ? "The last verified provider request completed."
          : planned
            ? "No runtime probe exists for a roadmap-only entry."
            : "The latest verified provider request needs review.",
      },
      {
        key: "credential_boundary",
        label: "Credential boundary",
        state: healthy ? "ok" : planned ? "planned" : "warning",
        message: healthy
          ? "Only an existing secure-vault reference is recorded."
          : planned
            ? "No credentials are accepted for a planned entry."
            : "Renew the stored reference in the owning surface.",
      },
    ],
    retry_policy: {
      mode: planned ? "not_applicable" : "bounded_exponential",
      max_attempts: planned ? 0 : 5,
      backoff: planned ? "No runtime" : "30s to 15m with jitter",
      dead_letter: planned ? "Not applicable" : "Operator-visible run ledger",
      idempotency: planned ? "Not applicable" : "Connection and cursor scoped",
    },
    sync_history: planned
      ? []
      : [
          {
            at: healthy
              ? "2026-08-09T09:12:00.000Z"
              : "2026-08-08T18:20:00.000Z",
            action: "sync",
            status: healthy ? "completed" : "failed",
            attempts: healthy ? 1 : 5,
            message: healthy
              ? "Audience checkpoint recorded."
              : "Credential renewal is required.",
            ...(healthy ? {} : { error: "Recorded credential expired" }),
          },
        ],
    audit_trail: [
      {
        at: "2026-08-08T16:00:00.000Z",
        action: "health.reviewed",
        actor: "integration-operator@example.invalid",
        message: "Operator reviewed the provider boundary.",
      },
    ],
    data_delete: [
      {
        method: "OPEN",
        path:
          ("setup_path" in item ? item.setup_path : undefined) ??
          "/settings/integrations",
        description:
          "Use the owning surface to review retained data and provider cleanup evidence.",
      },
    ],
  };
}

function contractForSlug(slug: string) {
  const item = itemForSlug(slug);
  if (!item) return undefined;
  const actions = lifecycleActionsForSlug(slug);
  return {
    slug: item.slug,
    owner: item.badge === "planned" ? "roadmap_program" : "integration_owner",
    badge: item.badge,
    runtime_status: item.runtime_status,
    native_managed: false,
    native_verified: false,
    implementation_depth:
      item.runtime_status === "planned" ? "catalog_only" : "delegated_runtime",
    public_claim:
      item.runtime_status === "planned"
        ? "Roadmap visibility only; no runtime availability is claimed."
        : "A delegated setup path exists; provider completion is verified in its owning surface.",
    auth_modes:
      item.runtime_status === "planned" ? ["none"] : ["oauth_reference"],
    credential_storage:
      item.runtime_status === "planned"
        ? "No credentials accepted"
        : "Existing references remain in the workspace credential vault",
    secret_policy:
      "Raw provider secrets are never returned by catalog read endpoints.",
    setup_surface:
      ("setup_path" in item ? item.setup_path : undefined) ??
      "provider_documentation",
    monitoring: ["health_snapshot", "sync_history", "audit_trail"],
    lifecycle_actions: actions,
    bridge_channels: item.badge === "planned" ? [] : ["delegated_setup"],
    required_scopes:
      item.runtime_status === "planned" ? [] : ["integration:manage"],
    data_objects: item.capabilities,
    event_topics: item.capabilities.slice(0, 2),
    compliance_gates: ["tenant_scope", "consent_boundary"],
    privacy_actions: ["disconnect", "retention_review"],
    rate_limit_policy: "Provider-specific bounded retry with jitter",
    partner_review: item.badge === "planned" ? "not_started" : "owner_verified",
  };
}

function detailForSlug(slug: string) {
  const item = itemForSlug(slug);
  const connection = connectionForSlug(slug);
  const health = healthForSlug(slug);
  const contract = contractForSlug(slug);
  if (!item || !connection || !health || !contract) return undefined;
  return {
    item,
    connection,
    setup: [
      {
        title: "Review the exact workspace target",
        description:
          "Confirm ownership, account identity, and least-privilege scope before leaving Moosewave.",
        action: "Open owning surface",
        path:
          ("setup_path" in item ? item.setup_path : undefined) ?? item.docs_url,
        required_fields: ["account_identity", "scope_review"],
      },
      {
        title: "Verify recorded health",
        description:
          "Return after setup and refresh evidence before treating the connection as complete.",
      },
    ],
    recipes: recipesForSlug(slug),
    lifecycle_actions: lifecycleActionsForSlug(slug),
    health,
    contract,
  };
}

function recipeForID(id: string) {
  return RECIPES_RESPONSE.items.find((recipe) => recipe.id === id);
}

function requestEvidence(route: Route): IntegrationsRequestEvidence {
  const request = route.request();
  const url = new URL(request.url());
  return {
    method: request.method(),
    pathname: url.pathname,
    search: url.search,
    body: request.postData(),
  };
}

async function json(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}

function resourceForPath(pathname: string): IntegrationsResource | null {
  const match = pathname.match(
    /^\/api\/v1\/integrations\/(catalog|connections|coverage|stacks|readiness|recipes)$/u,
  );
  return (match?.[1] as IntegrationsResource | undefined) ?? null;
}

function delegatedActionResponse(
  slug: string,
  action: Exclude<ExpectedIntegrationMutation["action"], "recipe/prepare">,
) {
  return {
    slug,
    action,
    status: "delegated",
    message:
      "The request was delegated; no connection state was changed in the catalog.",
    delegated_to: "owning_integration_surface",
    primary_connection_id:
      slug === HEALTHY_SLUG ? HEALTHY_CONNECTION_ID : undefined,
    connection_ids: slug === HEALTHY_SLUG ? [HEALTHY_CONNECTION_ID] : undefined,
    required_fields: ["exact_account", "operator_confirmation"],
    manage_path:
      (() => {
        const item = itemForSlug(slug);
        return item && "setup_path" in item ? item.setup_path : undefined;
      })() ?? "/settings/integrations",
  };
}

function verifyMutation(
  harness: IntegrationsHarness,
  evidence: IntegrationsRequestEvidence,
  target: string,
  action: ExpectedIntegrationMutation["action"],
): boolean {
  const expected = harness.expectedMutations.shift();
  const expectedBody = evidence.method === "DELETE" ? null : "{}";
  if (
    !expected ||
    expected.target !== target ||
    expected.action !== action ||
    evidence.body !== expectedBody
  ) {
    harness.unexpected.push(
      `Unexpected mutation ${evidence.method} ${evidence.pathname} (${target}:${action}); expected ${expected ? `${expected.target}:${expected.action}` : "none"}; body=${String(evidence.body)}`,
    );
    return false;
  }
  harness.mutations.push({
    ...expected,
    ...evidence,
    responseStatus: "delegated",
  });
  return true;
}

export async function installIntegrationsHarness(
  page: Page,
  options: Pick<
    OpenIntegrationsOptions,
    "failResources" | "crmRegistryFailuresBeforeSuccess"
  > = {},
): Promise<IntegrationsHarness> {
  const harness: IntegrationsHarness = {
    requests: [],
    mutations: [],
    expectedMutations: [],
    unexpected: [],
  };
  const failedResources = new Set(options.failResources ?? []);
  let crmRegistryFailuresRemaining =
    options.crmRegistryFailuresBeforeSuccess ?? 0;

  // Keep the authenticated shell healthy while Route #33 is under test. The
  // shared visual fixture intentionally predates the dashboard layout's
  // non-empty-order contract; an empty order now produces an unrelated error
  // toast that can obscure integration overlays and contaminate screenshots.
  await page.route("**/api/v1/dashboard/layout", async (route) => {
    if (route.request().method() !== "GET") {
      harness.unexpected.push(
        `Unexpected shell layout mutation ${route.request().method()}`,
      );
      await json(
        route,
        { error: { code: "unexpected_dashboard_layout_mutation" } },
        405,
      );
      return;
    }
    await json(route, {
      userId: "visual-user",
      tenantId: "test-tenant",
      order: [
        "subs",
        "opens",
        "clicks",
        "bounces",
        "forecast",
        "anomalies",
        "goals",
        "benchmarks",
        "engagement",
        "parity",
        "inbox-health",
        "clv",
      ],
      updatedAt: FIXED_TIME,
    });
  });

  // The shared shell fixture exercises the API-key fallback when its native
  // cookie broker is unavailable, but its generic stub predates this
  // authoritative identity endpoint. Keep Route #33's admin affordances tied
  // to server-shaped scopes instead of bypassing RBAC in the component.
  await page.route("**/api/v1/api-keys/me", async (route) => {
    await json(route, {
      tenant_id: "test-tenant",
      tenant_slug: "postwave",
      scopes: ["read", "write", "admin"],
      actor: "visual-test@example.invalid",
    });
  });

  await page.route("https://cdn.simpleicons.org/**", async (route) => {
    const request = route.request();
    harness.unexpected.push(
      `External icon egress ${request.method()} ${request.url()}`,
    );
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("https://www.google.com/s2/favicons**", async (route) => {
    const request = route.request();
    harness.unexpected.push(
      `External icon egress ${request.method()} ${request.url()}`,
    );
    await route.fulfill({ status: 204, body: "" });
  });

  await page.route("**/api/v1/crm/**", async (route) => {
    const evidence = requestEvidence(route);
    harness.requests.push(evidence);
    if (
      evidence.method === "GET" &&
      evidence.pathname === "/api/v1/crm/providers"
    ) {
      if (crmRegistryFailuresRemaining > 0) {
        crmRegistryFailuresRemaining -= 1;
        await json(
          route,
          {
            error: {
              code: "crm_registry_temporarily_unavailable",
              message:
                "CRM provider registry is temporarily unavailable; retry is safe.",
            },
          },
          503,
        );
        return;
      }
      await json(route, CRM_PROVIDER_REGISTRY);
      return;
    }
    harness.unexpected.push(
      `Unstubbed native CRM request ${evidence.method} ${evidence.pathname}${evidence.search}`,
    );
    await json(
      route,
      {
        error: {
          code: "undeclared_native_crm_request",
          message:
            "The integrations evidence harness rejects undeclared CRM writes.",
        },
      },
      409,
    );
  });

  await page.route("**/api/v1/integrations/**", async (route) => {
    const evidence = requestEvidence(route);
    const { method, pathname } = evidence;
    harness.requests.push(evidence);

    const resource = resourceForPath(pathname);
    if (resource && method === "GET" && failedResources.has(resource)) {
      await json(
        route,
        {
          error: {
            code: `${resource}_evidence_unavailable`,
            message: `${resource} evidence is temporarily unavailable; no value was inferred.`,
          },
        },
        503,
      );
      return;
    }

    if (pathname === "/api/v1/integrations/catalog" && method === "GET") {
      await json(route, CATALOG);
      return;
    }
    if (pathname === "/api/v1/integrations/connections" && method === "GET") {
      await json(route, CONNECTIONS_RESPONSE);
      return;
    }
    if (pathname === "/api/v1/integrations/coverage" && method === "GET") {
      await json(route, COVERAGE);
      return;
    }
    if (pathname === "/api/v1/integrations/stacks" && method === "GET") {
      await json(route, STACKS);
      return;
    }
    if (pathname === "/api/v1/integrations/readiness" && method === "GET") {
      await json(route, READINESS);
      return;
    }
    if (pathname === "/api/v1/integrations/recipes" && method === "GET") {
      await json(route, RECIPES_RESPONSE);
      return;
    }

    const recipeMatch = pathname.match(
      /^\/api\/v1\/integrations\/recipes\/([^/]+)(?:\/(apply))?$/u,
    );
    if (recipeMatch) {
      const recipeID = decodeURIComponent(recipeMatch[1]!);
      const recipe = recipeForID(recipeID);
      if (!recipe) {
        harness.unexpected.push(`Unknown recipe target: ${recipeID}`);
        await json(route, { error: { message: "Unknown recipe" } }, 404);
        return;
      }
      if (!recipeMatch[2] && method === "GET") {
        await json(route, {
          recipe,
          source: itemForSlug(recipe.source_slug),
          target: recipe.target_slug
            ? itemForSlug(recipe.target_slug)
            : undefined,
        });
        return;
      }
      if (recipeMatch[2] === "apply" && method === "POST") {
        if (!verifyMutation(harness, evidence, recipeID, "recipe/prepare")) {
          await json(route, { error: { message: "Mutation mismatch" } }, 409);
          return;
        }
        await json(route, {
          recipe_id: recipeID,
          status: "delegated",
          message:
            "Setup plan prepared. No automation or provider connection was created.",
          delegated_to: "webhook_workspace",
          manage_path:
            ("setup_path" in recipe ? recipe.setup_path : undefined) ??
            "/webhooks",
          required_fields: ["audience_id", "destination_id"],
          next_steps: recipe.steps,
          blueprint: recipe.blueprint,
        });
        return;
      }
    }

    const itemRoute = pathname.match(
      /^\/api\/v1\/integrations\/([^/]+)(?:\/(health|contract|connect\/start|connect\/callback|oauth\/availability|oauth\/start|oauth\/callback|sync|backfill|pause|provider-cleanup\/acknowledge|roadmap))?$/u,
    );
    if (itemRoute) {
      const slug = decodeURIComponent(itemRoute[1]!);
      const suffix = itemRoute[2];
      const item = itemForSlug(slug);
      if (!item) {
        harness.unexpected.push(`Unknown integration target: ${slug}`);
        await json(route, { error: { message: "Unknown integration" } }, 404);
        return;
      }
      if (!suffix && method === "GET") {
        await json(route, detailForSlug(slug));
        return;
      }
      if (suffix === "health" && method === "GET") {
        await json(route, healthForSlug(slug));
        return;
      }
      if (suffix === "contract" && method === "GET") {
        await json(route, contractForSlug(slug));
        return;
      }

      const action =
        !suffix && method === "DELETE"
          ? "disconnect"
          : (suffix as Exclude<
              ExpectedIntegrationMutation["action"],
              "recipe/prepare"
            >);
      if ((method === "POST" && suffix) || (method === "DELETE" && !suffix)) {
        if (!verifyMutation(harness, evidence, slug, action)) {
          await json(route, { error: { message: "Mutation mismatch" } }, 409);
          return;
        }
        await json(route, delegatedActionResponse(slug, action));
        return;
      }
    }

    harness.unexpected.push(
      `Unstubbed ${method} ${pathname}${evidence.search}`,
    );
    await json(
      route,
      { error: { message: "Unstubbed integrations evidence route" } },
      501,
    );
  });

  return harness;
}

export function expectNextMutation(
  harness: IntegrationsHarness,
  mutation: ExpectedIntegrationMutation,
): void {
  harness.expectedMutations.push(mutation);
}

export async function openIntegrations(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: OpenIntegrationsOptions = {},
): Promise<IntegrationsHarness> {
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1440,
    height: options.height ?? 1000,
  });
  await page.clock.setFixedTime(new Date(FIXED_TIME));
  await bootApp(page);
  // The packaged shell keeps its remembered cookie-session hint in
  // sessionStorage. The shared visual fixture still writes the retired
  // `postwave_session` flag, so seed the current bounded identity shape here
  // and let the normal /auth/me stub upgrade it during boot.
  await page.addInitScript(() => {
    window.sessionStorage.setItem(
      "postwave_session_user",
      JSON.stringify({
        user_id: "visual-user",
        tenant_id: "test-tenant",
        role: "admin",
        effective_role: "admin",
        auth_provider: "password",
      }),
    );
  });
  const harness = await installIntegrationsHarness(page, options);

  await page.goto("/");
  await waitForPrimaryNavigation(page);
  const destination = page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="integrations"]')
    .last();
  await destination.click();

  await expect(destination).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Integrations", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".integrations-page")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Integration catalog")).toBeVisible();
  return harness;
}

export async function waitForRefresh(
  harness: IntegrationsHarness,
): Promise<void> {
  await expect
    .poll(
      () =>
        harness.requests.filter(
          ({ method, pathname }) =>
            method === "GET" && pathname === "/api/v1/integrations/catalog",
        ).length,
    )
    .toBeGreaterThan(1);
}

export function catalogCard(page: Page, name: string) {
  return page
    .getByLabel("Integration catalog")
    .locator("article")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const route = document.querySelector<HTMLElement>(".integrations-page");
    return {
      document: document.documentElement.scrollWidth - window.innerWidth,
      body: document.body.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
      route: route ? route.scrollWidth - route.clientWidth : 0,
    };
  });
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.content).toBeLessThanOrEqual(1);
  expect(overflow.route).toBeLessThanOrEqual(1);
}

export async function seriousAxeViolations(
  page: Page,
  options: { rootSelector?: string; disableColorContrast?: boolean } = {},
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async ({ rootSelector, disableColorContrast }) => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            root: Element | Document,
            options: {
              runOnly: { type: "tag"; values: string[] };
              rules?: Record<string, { enabled: boolean }>;
            },
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{
                target: string[];
                failureSummary?: string;
              }>;
            }>;
          }>;
        };
      }
    ).axe;
    const root = rootSelector ? document.querySelector(rootSelector) : document;
    if (!root) throw new Error(`Axe root not found: ${rootSelector}`);
    const result = await axe.run(root, {
      runOnly: {
        type: "tag",
        values: [
          "wcag2a",
          "wcag2aa",
          "wcag21a",
          "wcag21aa",
          "wcag22a",
          "wcag22aa",
        ],
      },
      ...(disableColorContrast
        ? { rules: { "color-contrast": { enabled: false } } }
        : {}),
    });
    return result.violations
      .filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      )
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          failure: node.failureSummary,
        })),
      }));
  }, options);
}

export function observeRenderer(
  page: Page,
  allowedHttpStatuses: readonly number[] = [],
): { expectClean: () => void } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    expectClean: () => {
      expect(
        consoleErrors.filter(
          (message) =>
            !allowedHttpStatuses.some((status) =>
              message.includes(`status of ${status}`),
            ),
        ),
      ).toEqual([]);
      expect(pageErrors).toEqual([]);
    },
  };
}

export async function saveEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await expect(
    page.getByText("Couldn't load your saved Dashboard layout.", {
      exact: false,
    }),
  ).toHaveCount(0);
  await page.evaluate(async () => {
    const main = document.querySelector<HTMLElement>(".main");
    const content = document.querySelector<HTMLElement>(".content");
    const reset = (): void => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      main?.scrollTo({ top: 0, left: 0, behavior: "auto" });
      content?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    };
    reset();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    reset();
  });
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

export async function attachJson(
  testInfo: TestInfo,
  name: string,
  value: unknown,
): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    contentType: "application/json",
  });
}
