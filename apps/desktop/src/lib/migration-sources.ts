/**
 * Migration source catalog — typed definitions for the cards shown on
 * Step 1 of the wizard, plus per-source connection field schemas used
 * by Step 2.
 *
 * The IDs map 1:1 onto `canonical.SourcePlatform` in
 * packages/migrate/canonical/types.go. `other` is the only UI-only
 * fallback for HTML / API platforms with no adapter.
 *
 * Logos are intentionally text-only (initials) — fetching brand logos
 * raises legal questions and bloats the bundle. Each card renders a
 * 56×56 rounded tile, brand-coloured background, white initials.
 */

import { activeCampaignApiUrlError } from "./activecampaign-api-url";

export type MigrationSourceId =
  | "mailchimp"
  | "klaviyo"
  | "customerio"
  | "constant-contact"
  | "aweber"
  | "drip"
  | "campaign-monitor"
  | "omnisend"
  | "loops"
  | "flodesk"
  | "bento"
  | "activecampaign"
  | "substack"
  | "beehiiv"
  | "convertkit"
  | "mailerlite"
  | "brevo"
  | "hubspot"
  | "sendy"
  | "csv"
  | "other";

export type FieldKind =
  | "text"
  | "password"
  | "url"
  | "email"
  | "textarea"
  | "file";

export interface SourceField {
  /** Form field key (also matches the JSON key sent to the API). */
  key: string;
  /** Human-facing label shown above the input. */
  label: string;
  kind: FieldKind;
  required?: boolean;
  /** Inline placeholder. */
  placeholder?: string;
  /** Helper copy shown below the input — explains where to find it. */
  help?: string;
  /** Cap on input length to keep forms tidy. */
  maxLength?: number;
}

export interface MigrationSourceDef {
  id: MigrationSourceId;
  /** Display name (matches marketing site copy). */
  name: string;
  /** 2-letter initials for the logo tile. */
  initials: string;
  /** Brand background colour for the tile. */
  color: string;
  /** Whether the foreground text on the tile should be black (for
   *  light brand colours like Mailchimp yellow). */
  darkText?: boolean;
  /** One-liner shown under the name on the source card. */
  tagline: string;
  /**
   * Whether the migration backend has an adapter for this source today.
   * False sources are still selectable but show an honest "Server support
   * shipping" banner on the Connect step instead of pretending to work.
   */
  serverSupport: boolean;
  /** Auth flow style. Determines what Step 2 renders. */
  authFlow: "api_key" | "oauth" | "csv_upload" | "manual_notes";
  /** Connection field schema for Step 2. Empty for OAuth flows. */
  fields: SourceField[];
  /** Server-advertised automation handling; never inferred client-side. */
  automationMode?: "runtime" | "rebuild_review" | "none";
  /**
   * Set when the deployment advertises an authorization flow this desktop
   * build has no matching input/handoff contract for. The source must remain
   * unavailable until a client with that exact contract is installed.
   */
  runtimeCompatibilityError?: string;
  /** Whether this deployment can accept setup material for this source. */
  intakeAvailable?: boolean;
  intakeUnavailableReason?: string;
  /** Whether this deployment attests that a dry-run may advance to commit. */
  commitAvailable?: boolean;
  commitUnavailableReason?: string;
}

export type ConnectionValues = Record<string, string | File | null | undefined>;

export interface MigrationCredentialInput {
  apiKey: string;
  accountId: string;
  extra: Record<string, string>;
}

export interface RuntimeMigrationCapability {
  source: string;
  auth_method: string;
  intake_available?: boolean;
  intake_unavailable_code?: string;
  commit_available?: boolean;
  commit_unavailable_code?: string;
  supports?: Record<string, boolean | string | undefined>;
}

/**
 * Reconcile display metadata with the server's registered adapter contract.
 * Static definitions supply labels and form fields; the runtime matrix is
 * authoritative for availability and authentication method.
 */
export function applyRuntimeMigrationCapability(
  source: MigrationSourceDef,
  capability: RuntimeMigrationCapability | undefined,
): MigrationSourceDef {
  if (!capability) return { ...source, serverSupport: false };
  if (capability.source !== source.id) {
    return {
      ...source,
      serverSupport: false,
      fields: [],
      runtimeCompatibilityError:
        "The deployment capability row does not match the selected migration source. Refresh the catalog before connecting.",
      intakeAvailable: false,
      intakeUnavailableReason:
        "No credential or file can be accepted from a mismatched source capability.",
      commitAvailable: false,
      commitUnavailableReason:
        "A real import is unavailable until the source capability identity is verified.",
    };
  }
  const authFlow =
    capability.auth_method === "oauth2"
      ? "oauth"
      : capability.auth_method === "csv_upload"
        ? "csv_upload"
        : capability.auth_method === "api_key"
          ? "api_key"
          : "manual_notes";
  if (authFlow !== source.authFlow) {
    return {
      ...source,
      serverSupport: false,
      fields: [],
      runtimeCompatibilityError: `This deployment requires ${migrationAuthFlowLabel(authFlow)}, but this desktop build supports ${migrationAuthFlowLabel(source.authFlow)} for ${source.name}. Update the desktop app before connecting.`,
      intakeAvailable: false,
      intakeUnavailableReason:
        "This desktop build cannot safely satisfy the deployment authorization contract.",
      commitAvailable: false,
      commitUnavailableReason:
        "A real import is unavailable until the desktop and deployment contracts match.",
    };
  }
  const intakeAvailable =
    capability.intake_available === true ||
    (capability.intake_available === undefined && authFlow !== "csv_upload");
  const commitAvailable = capability.commit_available === true;
  const automationMode = capability.supports?.automation_mode;
  const tagline =
    source.id === "klaviyo"
      ? "Primary-email profiles plus enumerated send-targetable list/segment projections and sent email history import; no separate raw membership count is exposed. Secondary addresses, per-address consent, and nullable flow/draft-message definitions require manual review; campaign tags retain IDs only, SMS/push stays source-archive evidence, and eight static checklist rows do not prove product inventory."
      : source.id === "customerio"
        ? 'Email-addressable profiles are bound to immutable cio_id identities. Email requires global subscribed + resolved email-channel subscribed/default + applicable topic subscribed/default; ESP suppressions still block. Duplicate-email profiles and profiles without email stay explicit, while sender-specific SMS/WhatsApp /v1/optouts remain separate non-email evidence. Segment memberships are frozen snapshots. Sent email history requires an explicit language="" default; the lowest stable ID represents a multi-default/A-B set, every variant remains evidence, and HTML is source composition rather than provider rendering. Design Studio imports exact source HTML with fidelity review. Automations and non-email channels remain rebuild/source evidence.'
        : source.id === "beehiiv"
          ? "Subscribers and sent-post history import; segments and automations stay rebuild evidence, and premium memberships stay metadata rather than Stripe billing."
          : source.id !== "mailchimp"
            ? source.tagline
            : automationMode === "runtime"
              ? "The validated Classic welcomeSeries subset migrates paused; other Classic workflows and Customer Journeys require manual rebuild."
              : automationMode === "rebuild_review"
                ? "Classic Automations import for rebuild review; Customer Journeys remain manual."
                : "Classic Automations and Customer Journeys require manual rebuild.";
  return {
    ...source,
    serverSupport: true,
    authFlow,
    fields: authFlow === source.authFlow ? source.fields : [],
    runtimeCompatibilityError: undefined,
    intakeAvailable,
    intakeUnavailableReason: intakeAvailable
      ? undefined
      : capability.intake_unavailable_code ===
          "durable_upload_storage_unavailable"
        ? "File intake is unavailable because this deployment has not attested durable, restart-safe upload storage."
        : "This deployment has not attested that source setup is available.",
    commitAvailable,
    commitUnavailableReason: commitAvailable
      ? undefined
      : capability.commit_unavailable_code === "tenant_destination_not_isolated"
        ? "Real import is unavailable because the subscriber destination is not isolated and bound to this exact workspace. Dry-run review remains available."
        : "This deployment has not attested that a real import is available. Dry-run review remains available.",
    tagline,
    ...(automationMode === "runtime" ||
    automationMode === "rebuild_review" ||
    automationMode === "none"
      ? { automationMode }
      : {}),
  };
}

function migrationAuthFlowLabel(flow: MigrationSourceDef["authFlow"]): string {
  switch (flow) {
    case "oauth":
      return "browser OAuth";
    case "api_key":
      return "an API credential";
    case "csv_upload":
      return "a CSV upload";
    case "manual_notes":
      return "a manually reviewed connection";
  }
}

export const MIGRATION_SOURCES: MigrationSourceDef[] = [
  {
    id: "mailchimp",
    name: "Mailchimp",
    initials: "MC",
    color: "#FFE01B",
    darkText: true,
    tagline:
      "Audiences and archives; automation behavior follows server capability.",
    serverSupport: true,
    authFlow: "oauth",
    fields: [],
  },
  {
    id: "klaviyo",
    name: "Klaviyo",
    initials: "KV",
    color: "#111827",
    tagline:
      "Primary-email profiles, send-targetable membership projections, templates, and sent email history; secondary identity and nullable-definition gaps require review, campaign tags retain IDs, and static checklists are not inventory.",
    serverSupport: true,
    authFlow: "api_key",
    fields: [
      {
        key: "api_key",
        label: "Private API key",
        kind: "password",
        required: true,
        placeholder: "pk_...",
        help: "Create a dedicated Klaviyo private key with read access to accounts, profiles, lists, segments, flows, campaigns and campaign messages, forms, and templates. Profile reads include predictive analytics and use its stricter 10/second, 150/minute tier. Stable profile retrieval exposes only the primary email; reconcile secondary addresses and independent per-address consent through the preserved source-archive record. Membership counts/tags are the enumerated send-targetable projection after validated list-level suppressions, not a separately exposed raw count. Unnamed audiences use deterministic Klaviyo list/segment ID labels. Draft campaign-message and flow definitions may be null and then require recovery or retirement. Campaign tags retain provider IDs, not names/groups. Eight unconditional static checklist rows each use source_total=1 but do not prove product inventory. Reports, SMS runtime, and ecommerce are not imported; sent SMS/push campaign records remain non-executable source-archive evidence.",
        maxLength: 500,
      },
    ],
  },
  {
    id: "customerio",
    name: "Customer.io",
    initials: "CI",
    color: "#00B3B8",
    darkText: true,
    tagline:
      "Email-addressable cio_id profiles, frozen segment memberships, and sent email one-time sends; three-layer email eligibility, duplicate-email identities, automations, and non-email channels require review.",
    serverSupport: true,
    authFlow: "api_key",
    fields: [
      {
        key: "api_key",
        label: "App API key",
        kind: "password",
        required: true,
        placeholder: "Customer.io App API key",
        help: 'Use a dedicated Customer.io App API key, not a Track API site key. Moosewave validates the exact US/EU workspace, traverses email-addressable profiles by immutable cio_id, and hydrates global, subscription-center channel, and topic preferences. Email is enabled only when global state is subscribed, the resolved email-channel state is subscribed explicitly or by configured default, and the applicable topic is subscribed explicitly or by configured default; ESP suppressions still block. Sender-specific SMS/WhatsApp /v1/optouts are separate non-email evidence. Duplicate-email identities remain explicit. Sent-newsletter history requires an explicit language="" default, deterministic lowest-ID A/B representation, and provable source layout/body composition; Design Studio imports exact source HTML rather than provider-rendered output. Dynamic segment rules and automations do not become live runtime; other App API resources are archived or retained as review/rebuild evidence according to the server capability report.',
        maxLength: 500,
      },
      {
        key: "account_id",
        label: "Workspace ID",
        kind: "text",
        placeholder: "Customer.io workspace ID",
        help: "Optional for a key that exposes exactly one workspace. Required when the App API key exposes multiple workspaces; Moosewave fails closed instead of choosing one by discovery order.",
        maxLength: 64,
      },
      {
        key: "extra.region",
        label: "Region",
        kind: "text",
        placeholder: "us or eu",
        help: "Optional. Defaults to us; set eu for api-eu.customer.io workspaces.",
        maxLength: 8,
      },
    ],
  },
  {
    id: "activecampaign",
    name: "ActiveCampaign",
    initials: "AC",
    color: "#004CFF",
    tagline:
      "Fail-closed email contacts, hydrated campaigns, rebuild definitions, and read-only CRM/SMS evidence.",
    serverSupport: true,
    authFlow: "api_key",
    fields: [
      {
        key: "api_key",
        label: "API token",
        kind: "password",
        required: true,
        placeholder: "ActiveCampaign API token",
        help: "Settings → Developer → API Access. Use a dedicated migration user because API tokens follow that user's account access.",
        maxLength: 400,
      },
      {
        key: "extra.api_url",
        label: "Account API URL",
        kind: "url",
        required: true,
        placeholder: "https://youraccount.api-us1.com/api/3",
        help: "Use the exact HTTPS account URL shown next to your token. Built-in ActiveCampaign hosts work by default; other provider-issued hosts must be authorized by the Moosewave deployment. Reconnect and cutover stay bound to that same account.",
        maxLength: 240,
      },
    ],
  },
  {
    id: "hubspot",
    name: "HubSpot",
    initials: "HS",
    color: "#FF7A59",
    darkText: true,
    tagline:
      "Portal-bound CRM bridge with exact preferences, conservative current-email eligibility, frozen audiences, and hard final-snapshot cutover.",
    serverSupport: true,
    authFlow: "api_key",
    fields: [
      {
        key: "api_key",
        label: "Private app access token",
        kind: "password",
        required: true,
        placeholder: "pat-na1-...",
        help: "Create a dedicated HubSpot private app with crm.objects.contacts.read, crm.schemas.contacts.read, crm.lists.read, subscriptions-definition-read, and subscriptions-status-read, plus access to 2026-03 account details and private-app daily API usage. Enterprise-only batch subscription scopes are not required because Moosewave uses per-contact reads. Enabled requires every active email definition SUBSCRIBED and no wide/scoped opt-out, hard-bounce, quarantine, invalid-address, marketing-contact, pending/unconfirmed double-opt-in, or legacy-opt-out restriction; NOT_SPECIFIED remains unconfirmed. This is conservative current-primary-email eligibility, not exact HubSpot sendability parity; a primary-email change requires a fresh full snapshot. Discovery fails closed above 1,000,000 contacts, 10,000 pages, 64 MiB retained snapshot data, the 10,000-result search bound, or its reserved daily API budget.",
        maxLength: 500,
      },
      {
        key: "account_id",
        label: "Hub ID (optional)",
        kind: "text",
        placeholder: "12345678",
        help: "Optional numeric portal selector. Moosewave verifies it against 2026-03 account details, binds the job to that provider identity, and returns only a redacted portal marker.",
        maxLength: 64,
      },
    ],
  },
  {
    id: "substack",
    name: "Substack",
    initials: "SU",
    color: "#FF6719",
    darkText: true,
    tagline:
      "Official ZIP/CSV import for subscribers and sent-email posts; consent, billing, and ecosystem gaps stay explicit.",
    serverSupport: true,
    authFlow: "csv_upload",
    fields: [
      {
        key: "file",
        label: "Substack official ZIP or subscriber CSV",
        kind: "file",
        required: true,
        help: "Prefer the untouched official ZIP, which can include the All-columns subscriber list, posts.csv, HTML post fragments, and aggregate delivery/open evidence. A standalone subscriber CSV imports audience rows only. Signup dates remain provenance, active rows remain unconfirmed, and Stripe/Apple billing requires a separate publication-bound handoff.",
      },
    ],
  },
  {
    id: "beehiiv",
    name: "Beehiiv",
    initials: "BE",
    color: "#FFD700",
    darkText: true,
    tagline:
      "Subscribers and sent-post history import; segments and automations stay rebuild evidence, and premium memberships stay metadata rather than Stripe billing.",
    serverSupport: true,
    authFlow: "api_key",
    fields: [
      {
        key: "api_key",
        label: "API key",
        kind: "password",
        required: true,
        placeholder: "Beehiiv API key",
        help: "Settings → Integrations → API keys. Required reads: identify, publications, subscriptions, newsletter lists, segments, condition sets, automations, posts, and custom fields.",
        maxLength: 200,
      },
      {
        key: "publication_id",
        label: "Publication ID",
        kind: "text",
        required: true,
        placeholder: "pub_xxxxxxxx",
        help: "Found in the URL of your Beehiiv dashboard. Moosewave binds this exact publication; no workspace publication chooser is available.",
        maxLength: 64,
      },
    ],
  },
  {
    id: "convertkit",
    name: "Kit (ConvertKit)",
    initials: "CK",
    color: "#FB6970",
    darkText: true,
    tagline: "Subscribers, tags, sequences.",
    serverSupport: true,
    authFlow: "oauth",
    fields: [],
  },
  {
    id: "mailerlite",
    name: "MailerLite",
    initials: "ML",
    color: "#09C269",
    darkText: true,
    tagline: "Subscribers, groups, automations.",
    serverSupport: true,
    authFlow: "api_key",
    fields: [
      {
        key: "api_key",
        label: "API key",
        kind: "password",
        required: true,
        placeholder: "MailerLite API key",
        help: "Profile → Integrations → MailerLite API.",
        maxLength: 200,
      },
    ],
  },
  {
    id: "brevo",
    name: "Brevo",
    initials: "BR",
    color: "#0B996C",
    darkText: true,
    tagline: "Import from Brevo (formerly Sendinblue).",
    serverSupport: true,
    authFlow: "api_key",
    fields: [
      {
        key: "api_key",
        label: "API key",
        kind: "password",
        required: true,
        placeholder: "xkeysib-…",
        help:
          "Settings → SMTP & API → API Keys → Generate a new API key. " +
          "Brevo passes this in the api-key header.",
        maxLength: 200,
      },
    ],
  },
  {
    id: "sendy",
    name: "Sendy CSV",
    initials: "SE",
    color: "#3792AD",
    darkText: true,
    tagline: "Self-hosted subscriber CSV export.",
    serverSupport: true,
    authFlow: "csv_upload",
    fields: [
      {
        key: "file",
        label: "Sendy subscriber export CSV",
        kind: "file",
        required: true,
        help:
          "In Sendy, open the list and choose Export all subscribers. " +
          "Sendy's official API does not expose a complete export endpoint, " +
          "so Moosewave uses the CSV for a data-loss-safe migration.",
      },
    ],
  },
  {
    id: "constant-contact",
    name: "Constant Contact CSV",
    initials: "CC",
    color: "#185ABC",
    tagline: "Subscribers from Constant Contact contact exports.",
    serverSupport: true,
    authFlow: "csv_upload",
    fields: [
      {
        key: "file",
        label: "Constant Contact contact export CSV",
        kind: "file",
        required: true,
        help: "Export contacts from Constant Contact and upload the CSV. Moosewave imports subscribers and preserves extra columns as profile fields.",
      },
    ],
  },
  {
    id: "aweber",
    name: "AWeber CSV",
    initials: "AW",
    color: "#1273DE",
    tagline: "Subscribers from AWeber list exports.",
    serverSupport: true,
    authFlow: "csv_upload",
    fields: [
      {
        key: "file",
        label: "AWeber subscriber export CSV",
        kind: "file",
        required: true,
        help: "Export subscribers from AWeber and upload the CSV. Tags/status columns are preserved when present.",
      },
    ],
  },
  {
    id: "drip",
    name: "Drip CSV",
    initials: "DR",
    color: "#F25A38",
    darkText: true,
    tagline: "People from Drip subscriber exports.",
    serverSupport: true,
    authFlow: "csv_upload",
    fields: [
      {
        key: "file",
        label: "Drip people export CSV",
        kind: "file",
        required: true,
        help: "Upload a Drip people/subscriber CSV export. Source fields are retained as profile attributes.",
      },
    ],
  },
  {
    id: "campaign-monitor",
    name: "Campaign Monitor CSV",
    initials: "CM",
    color: "#7856FF",
    tagline: "Subscribers from Campaign Monitor list exports.",
    serverSupport: true,
    authFlow: "csv_upload",
    fields: [
      {
        key: "file",
        label: "Campaign Monitor subscriber export CSV",
        kind: "file",
        required: true,
        help: "Upload a Campaign Monitor list export CSV. Extra columns remain available as custom fields.",
      },
    ],
  },
  {
    id: "omnisend",
    name: "Omnisend CSV",
    initials: "OM",
    color: "#111827",
    tagline: "Contacts from Omnisend audience exports.",
    serverSupport: true,
    authFlow: "csv_upload",
    fields: [
      {
        key: "file",
        label: "Omnisend contact export CSV",
        kind: "file",
        required: true,
        help: "Upload an Omnisend contact export CSV. Email, status, tags, and attributes are mapped when present.",
      },
    ],
  },
  {
    id: "loops",
    name: "Loops CSV",
    initials: "LO",
    color: "#5B5FEF",
    tagline: "Contacts from Loops audience exports.",
    serverSupport: true,
    authFlow: "csv_upload",
    fields: [
      {
        key: "file",
        label: "Loops contact export CSV",
        kind: "file",
        required: true,
        help: "Upload a Loops contacts CSV export. Lifecycle attributes are preserved as profile fields.",
      },
    ],
  },
  {
    id: "flodesk",
    name: "Flodesk CSV",
    initials: "FD",
    color: "#111827",
    tagline: "Subscribers from Flodesk export files.",
    serverSupport: true,
    authFlow: "csv_upload",
    fields: [
      {
        key: "file",
        label: "Flodesk subscriber export CSV",
        kind: "file",
        required: true,
        help: "Upload a Flodesk subscriber CSV. Moosewave imports contacts and keeps source fields for review.",
      },
    ],
  },
  {
    id: "bento",
    name: "Bento CSV",
    initials: "BE",
    color: "#0F766E",
    tagline: "Subscribers from Bento people exports.",
    serverSupport: true,
    authFlow: "csv_upload",
    fields: [
      {
        key: "file",
        label: "Bento people export CSV",
        kind: "file",
        required: true,
        help: "Upload a Bento people CSV export. Tags and custom fields are preserved when included.",
      },
    ],
  },
  {
    id: "csv",
    name: "CSV upload",
    initials: "CS",
    color: "#6b7280",
    tagline: "Universal fallback for any platform.",
    serverSupport: true,
    authFlow: "csv_upload",
    fields: [
      {
        key: "file",
        label: "CSV file",
        kind: "file",
        required: true,
        help:
          "One row per subscriber. Required column: email. Optional: " +
          "name, status, tags, consent_at.",
      },
    ],
  },
  {
    id: "other",
    name: "Other (HTML / API)",
    initials: "OT",
    color: "#6b7280",
    tagline: "Have a custom platform? Tell us.",
    serverSupport: false,
    authFlow: "manual_notes",
    fields: [
      {
        key: "notes",
        label: "Tell us about your platform",
        kind: "textarea",
        required: true,
        placeholder:
          "Platform name, what data you have access to (CSV / API / HTML " +
          "archive), rough subscriber count.",
        help:
          "Moosewave engineers triage these requests within one business day. " +
          "We'll reach out at the email on your account.",
        maxLength: 4000,
      },
    ],
  },
];

/** Lookup helper. Returns `null` if id isn't in the catalog. */
export function findSource(
  id: MigrationSourceId | string,
): MigrationSourceDef | null {
  return MIGRATION_SOURCES.find((s) => s.id === id) ?? null;
}

export function migrationCredentialLabel(sourceId: string | undefined): string {
  switch (sourceId) {
    case "mailchimp":
    case "convertkit":
      return "OAuth connection";
    case "activecampaign":
      return "API token + account URL";
    case "hubspot":
      return "private app access token";
    case "klaviyo":
      return "private API key";
    case "customerio":
      return "App API key + workspace/region";
    default:
      return "API key";
  }
}

/**
 * Validate a draft form against a source's field schema.
 * Returns null on success, otherwise the first error message — keep this
 * synchronous so the wizard's Next button can disable in real time.
 */
export function validateConnection(
  source: MigrationSourceDef,
  values: ConnectionValues,
): string | null {
  for (const f of source.fields) {
    const v = values[f.key];
    if (f.required) {
      if (f.kind === "file") {
        if (!v) return `${f.label} is required.`;
      } else {
        const s = typeof v === "string" ? v.trim() : "";
        if (!s) return `${f.label} is required.`;
      }
    }
    if (f.kind === "url" && typeof v === "string" && v.trim()) {
      if (source.id === "activecampaign" && f.key === "extra.api_url") {
        return activeCampaignApiUrlError(v);
      }
      try {
        const u = new URL(v.trim());
        const localDevelopmentHost =
          u.hostname === "localhost" ||
          u.hostname === "127.0.0.1" ||
          u.hostname === "[::1]";
        if (
          u.protocol !== "https:" &&
          !(u.protocol === "http:" && localDevelopmentHost)
        ) {
          return `${f.label} must use HTTPS. Plain HTTP is accepted only for an explicit local development host.`;
        }
      } catch {
        return `${f.label} must be a valid URL.`;
      }
    }
    if (f.kind === "email" && typeof v === "string" && v.trim()) {
      if (!v.includes("@")) return `${f.label} must be a valid email.`;
    }
    if (
      source.id === "customerio" &&
      f.key === "account_id" &&
      typeof v === "string" &&
      v.trim() &&
      !/^\d{1,64}$/u.test(v.trim())
    ) {
      return "Workspace ID must contain 1 to 64 digits.";
    }
    if (
      source.id === "hubspot" &&
      f.key === "account_id" &&
      typeof v === "string" &&
      v.trim() &&
      !/^\d{1,64}$/u.test(v.trim())
    ) {
      return "Hub ID must contain 1 to 64 digits.";
    }
    if (
      source.id === "customerio" &&
      f.key === "extra.region" &&
      typeof v === "string" &&
      v.trim() &&
      !["us", "eu"].includes(v.trim().toLowerCase())
    ) {
      return "Region must be us or eu.";
    }
  }
  return null;
}

export function buildMigrationCredentialInput(
  source: MigrationSourceDef,
  values: ConnectionValues,
  initialState?: string,
): MigrationCredentialInput {
  const apiKey = pickConnectionString(values, "api_key");
  let accountId = pickConnectionString(values, "account_id");
  const extra: Record<string, string> = {};
  for (const f of source.fields) {
    if (f.key.startsWith("extra.")) {
      const ek = f.key.slice("extra.".length);
      const sv = pickConnectionString(values, f.key);
      if (sv) extra[ek] = sv;
    } else if (
      f.key !== "api_key" &&
      f.key !== "account_id" &&
      f.kind !== "file"
    ) {
      const sv = pickConnectionString(values, f.key);
      if (sv) extra[f.key] = sv;
    }
  }
  const state = initialState?.trim();
  if (state) {
    extra["state"] = state;
  }
  if (source.id === "activecampaign" && !accountId && extra["api_url"]) {
    accountId = extra["api_url"];
  }
  if (source.id === "hubspot" && accountId && !extra["hub_id"]) {
    extra["hub_id"] = accountId;
  }
  if (source.id === "beehiiv" && extra["publication_id"]) {
    accountId = extra["publication_id"];
  }
  if (source.id === "customerio" && extra["region"]) {
    extra["region"] = extra["region"].toLowerCase();
  }
  return { apiKey, accountId, extra };
}

function pickConnectionString(values: ConnectionValues, key: string): string {
  const v = values[key];
  return typeof v === "string" ? v.trim() : "";
}
