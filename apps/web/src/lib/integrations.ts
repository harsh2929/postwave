// SPDX-License-Identifier: AGPL-3.0-only
//
// Static integration catalog. Read by both the directory index
// (/integrations) and the per-integration template (/integrations/[slug]).
// Server-side only — there's nothing here that needs to ship to the client.

import {
  MCP_RELEASE_HOLD_CODE,
  MCP_RELEASE_STATUS_COPY,
  MCP_SOURCE_CANDIDATE_LABEL,
} from "@/lib/mcp-release-status";

export type IntegrationCategory =
  | "Communication"
  | "Commerce"
  | "Advertising"
  | "CRM"
  | "Support"
  | "Reviews"
  | "Loyalty"
  | "Analytics"
  | "Automation"
  | "AI";

export interface IntegrationSetupStep {
  /** A short imperative title rendered as the HowTo step name. */
  title: string;
  /** A 1–3 sentence description of the step. */
  body: string;
}

export interface IntegrationCodeExample {
  /** Lowercase shorthand: "bash", "ts", "json", … — drives the language hint. */
  language: string;
  /** Verbatim snippet body. Indentation matters; we render in <pre>. */
  code: string;
}

export interface Integration {
  slug: string;
  name: string;
  category: IntegrationCategory;
  /** ≤140 chars, used in cards and meta descriptions. */
  summary: string;
  /** 1–3 paragraph longer description rendered on the detail page. */
  description: string[];
  /** Bullet-list capabilities. Each ≤90 chars. */
  capabilities: string[];
  /** Exactly three setup steps — keeps the HowTo schema honest. */
  setupSteps: [
    IntegrationSetupStep,
    IntegrationSetupStep,
    IntegrationSetupStep,
  ];
  /** Code example (curl or JS preferred). */
  example: IntegrationCodeExample;
  /** Published first-party setup guide. Omitted until the route exists. */
  docsLink?: string;
  /** Internal-link suggestions rendered in a "Related" block. */
  related: { href: string; label: string }[];
  /** When present, discovery may render but setup/HowTo/example guidance is
   * suppressed because no runtime request is release-authorized. */
  runtimeHoldCode?: string;
  callbackIngressHoldCode?: string;
}

export const INTEGRATIONS: Integration[] = [
  {
    slug: "slack",
    name: "Slack",
    category: "Communication",
    summary:
      "Pipe campaign sends, deliverability alerts, and migration completions into a Slack channel of your choice.",
    description: [
      "Moosewave exposes two separate Slack paths. Incoming webhooks deliver the event types you select to a channel. The optional OAuth app powers campaign approval messages and the signed /moosewave command surface.",
      "The OAuth app currently implements /moosewave campaigns and /moosewave send <campaign_id>. Revoking an incoming webhook stops event notifications through that webhook; disconnecting the OAuth workspace stops approvals and slash commands.",
    ],
    capabilities: [
      "Selected Moosewave events delivered through an incoming webhook",
      "OAuth-backed campaign approval messages",
      "Slash command: /moosewave campaigns",
      "Slash command: /moosewave send <campaign_id>",
    ],
    setupSteps: [
      {
        title: "Choose the Slack path you need",
        body: "Use App → Integrations for incoming-webhook notifications. Use Settings → Integrations → Slack only when you also need campaign approvals and slash commands.",
      },
      {
        title: "Configure notifications or OAuth",
        body: "For notifications, paste a Slack incoming-webhook URL and select event types; Moosewave stores the URL encrypted. For approvals and commands, connect the optional Slack OAuth app.",
      },
      {
        title: "Verify the configured path",
        body: "Trigger one selected Moosewave event to verify an incoming webhook. For OAuth, run /moosewave campaigns, then use /moosewave send <campaign_id> to request approval for a real campaign.",
      },
    ],
    example: {
      language: "bash",
      code: `# Commands exposed by the optional OAuth app:
/moosewave campaigns
/moosewave send cmp_01JXYZ`,
    },
    docsLink: "/docs/integrations/slack",
    related: [
      { href: "/integrations/discord", label: "Discord" },
      { href: "/integrations/teams", label: "Microsoft Teams" },
      { href: "/integrations/webhook", label: "Custom webhooks" },
    ],
  },
  {
    slug: "discord",
    name: "Discord",
    category: "Communication",
    summary:
      "Post Moosewave events to a Discord channel. Useful for community-led newsletters with a Discord home base.",
    description: [
      "Discord is configured via webhook URL — Discord's webhook system is mature and a server admin can spin one up in seconds. Moosewave's Discord integration formats events as embeds with field values close to what you'd see in Slack.",
      "There is no slash-command surface today (Discord interactions require a hosted bot, which adds operational cost we don't want to take on for a feature this simple). Use webhook events to drive a community Discord bot of your own if you want richer interactions.",
    ],
    capabilities: [
      "Webhook-based event posting (no OAuth)",
      "Campaign and deliverability events",
      "Embed formatting with brand color",
      "Per-channel webhook URLs supported",
    ],
    setupSteps: [
      {
        title: "Create a Discord webhook",
        body: "In your Discord channel settings, go to Integrations → Webhooks → New Webhook. Copy the webhook URL.",
      },
      {
        title: "Paste into Moosewave",
        body: "Settings → Integrations → Discord → Add webhook. Paste the URL and pick which event categories to forward.",
      },
      {
        title: "Send a test event",
        body: "Click Send test. A branded embed appears in the channel. Discord shows webhook delivery status — if it fails, the response body is shown verbatim in Moosewave for debugging.",
      },
    ],
    example: {
      language: "json",
      code: `// Moosewave POSTs to your Discord webhook URL with a body like:
{
  "embeds": [{
    "title": "Campaign sent",
    "description": "Weekly Issue 47 — 18,205 recipients",
    "color": 13107246,
    "fields": [
      { "name": "Inbox placement", "value": "Observed across active seedlist" },
      { "name": "Sender", "value": "newsletter@example.com" }
    ],
    "timestamp": "2026-04-22T09:14:00Z"
  }]
}`,
    },
    related: [
      { href: "/integrations/slack", label: "Slack" },
      { href: "/integrations/webhook", label: "Custom webhooks" },
    ],
  },
  {
    slug: "teams",
    name: "Microsoft Teams",
    category: "Communication",
    summary:
      "Send Moosewave events to a Microsoft Teams channel via incoming webhook. Same event vocabulary as Slack and Discord.",
    description: [
      "Teams integration uses the Incoming Webhook connector. Once your Teams admin allows the connector in your tenant (often the slowest part of any Teams integration), the rest is a paste-and-test flow.",
      "Cards are MessageCard format with action links back to the Moosewave dashboard.",
    ],
    capabilities: [
      "Incoming Webhook connector",
      "Adaptive MessageCard format",
      "Action links back to dashboard",
      "Works inside teams that block third-party apps but allow connectors",
    ],
    setupSteps: [
      {
        title: "Add an incoming webhook to a channel",
        body: "In Teams, open the channel → Connectors → Incoming Webhook → Configure. Name it 'Moosewave', upload an icon, and copy the URL.",
      },
      {
        title: "Connect in Moosewave",
        body: "Settings → Integrations → Microsoft Teams → Add webhook. Paste the URL and choose event categories.",
      },
      {
        title: "Verify the test card",
        body: "Click Send test in Moosewave. A branded card appears with an Open in Moosewave action link.",
      },
    ],
    example: {
      language: "json",
      code: `// Moosewave posts MessageCard JSON to your Teams webhook:
{
  "@type": "MessageCard",
  "@context": "https://schema.org/extensions",
  "summary": "Campaign sent",
  "themeColor": "C8102E",
  "title": "Weekly Issue 47",
  "sections": [{
    "facts": [
      { "name": "Recipients", "value": "18,205" },
      { "name": "Inbox placement", "value": "97%" }
    ]
  }],
  "potentialAction": [{
    "@type": "OpenUri",
    "name": "Open in Moosewave",
    "targets": [{ "os": "default", "uri": "https://app.moosewave.com/c/47" }]
  }]
}`,
    },
    related: [
      { href: "/integrations/slack", label: "Slack" },
      { href: "/integrations/webhook", label: "Custom webhooks" },
    ],
  },
  {
    slug: "stripe",
    name: "Stripe",
    category: "Commerce",
    summary:
      "Pull Stripe customer, payment, invoice, dispute, credit-note, subscription, and refund evidence into Moosewave without charging subscribers.",
    description: [
      "The Stripe integration uses a restricted-key credential reference and a signed webhook endpoint to read customer, Checkout Session, PaymentIntent, charge, dispute, invoice, credit-note, subscription, and refund evidence into Moosewave.",
      "Moosewave does not create or duplicate subscriptions. The existing Stripe billing relationship is preserved, and disconnecting the integration stops Moosewave sync while Stripe Dashboard key, webhook endpoint, and signing-secret cleanup remains an operator action until live certification is complete.",
    ],
    capabilities: [
      "Restricted-key credential-reference auth",
      "Signed Stripe webhook ingest",
      "Payment, dispute, credit-note, invoice, subscription, and refund provider-event evidence",
      "Retry-aware REST backfill and disconnect cleanup readiness evidence",
    ],
    setupSteps: [
      {
        title: "Store restricted Stripe credentials",
        body: "Store a restricted read key and webhook signing secret in your trusted credential store. Pass only their references to Moosewave; raw credentials are rejected by the managed connector path.",
      },
      {
        title: "Create the managed connection",
        body: "Create a commerce integration with provider stripe, the Stripe account ID, the restricted-key credential reference, and the webhook-secret reference. Run an empty backfill to pull supported evidence.",
      },
      {
        title: "Configure and verify the webhook",
        body: "In Stripe Dashboard, point the required event topics at /api/public/commerce/stripe/webhooks. Moosewave verifies Stripe-Signature before ingest; webhook registration and provider-side cleanup remain operator-managed.",
      },
    ],
    example: {
      language: "text",
      code: "Moosewave CLI — Coming soon. Use the dashboard connection flow during the release candidate.",
    },
    docsLink: "/docs/integrations/stripe",
    related: [
      { href: "/integrations/shopify", label: "Shopify" },
      { href: "/migrations", label: "Paid newsletter migrations" },
    ],
  },
  {
    slug: "shopify",
    name: "Shopify",
    category: "Commerce",
    summary:
      "Sync Shopify customers and order events into Moosewave. Run post-purchase flows without a separate ESP.",
    description: [
      "The Shopify integration syncs customers and order events into Moosewave so you can run post-purchase, abandoned-cart, and re-engagement flows without bolting a second ESP onto your store.",
      "We only pull marketing-consenting customers by default. The consent timestamp from Shopify is preserved on the Moosewave subscriber record — if a customer ever opted out in Shopify, they stay opted out in Moosewave.",
    ],
    capabilities: [
      "Customer sync (marketing-consenting only)",
      "Order webhook events for automation triggers",
      "Auto-tag with product, collection, or order-value bands",
      "Per-store integration (multi-store accounts supported)",
    ],
    setupSteps: [
      {
        title: "Install the Moosewave Shopify app",
        body: "From your Shopify admin, install the Moosewave app from the Shopify App Store. The OAuth flow grants read access to customers and orders.",
      },
      {
        title: "Choose what to sync",
        body: "Pick whether to sync historical customers (one-time backfill) or only new customers from now on. Configure tag-mapping rules for products and collections.",
      },
      {
        title: "Trigger an automation",
        body: "Build an automation in Moosewave with trigger 'Shopify order placed' and use the order data in templates. Test with a real order in Shopify's preview mode.",
      },
    ],
    example: {
      language: "ts",
      code: `// Shopify webhook → Moosewave automation trigger
{
  "trigger": "shopify.order.placed",
  "match": {
    "products_includes": ["sku_handmade_set"],
    "total_price_gte": 50
  },
  "automation": "post-purchase-handmade-set"
}`,
    },
    related: [
      { href: "/integrations/stripe", label: "Stripe" },
      { href: "/integrations/zapier", label: "Zapier" },
    ],
  },
  {
    slug: "zapier",
    name: "Zapier",
    category: "Automation",
    summary:
      "Connect Moosewave to 6,000+ apps via Zapier. Triggers and actions for subscribers, campaigns, and automations.",
    description: [
      "Moosewave's Zapier app exposes the most-requested triggers (new subscriber, unsubscribe, campaign sent, automation entered) and the most-requested actions (create or update subscriber, add or remove tag, trigger an automation).",
      "We deliberately do not expose write-access to campaign content via Zapier — campaign authoring belongs in the editor where the AI fidelity scoring runs. If you need that, the API is the right surface.",
    ],
    capabilities: [
      "Triggers: new subscriber, unsubscribe, campaign sent, automation entered",
      "Actions: create / update subscriber, tag, trigger automation",
      "Auth via API key with scoped permissions",
      "OAuth available on enterprise plans",
    ],
    setupSteps: [
      {
        title: "Get your Zapier API key",
        body: "Settings → API keys → New key, scope to 'Zapier'. Copy the key.",
      },
      {
        title: "Connect Moosewave in Zapier",
        body: "In Zapier, search for the Moosewave app and click Connect. Paste your API key and the workspace ID Moosewave shows in Settings.",
      },
      {
        title: "Build your first Zap",
        body: "Pick a trigger (e.g. 'New subscriber') and a downstream action (e.g. 'Add row to Google Sheets'). Test the trigger with a real subscriber from Moosewave.",
      },
    ],
    example: {
      language: "json",
      code: `// Zap fires when a new subscriber lands in Moosewave
{
  "trigger": "subscriber.created",
  "data": {
    "email": "ada@example.com",
    "tags": ["welcome-flow", "source:landing-page"],
    "consent_at": "2026-04-22T09:14:00Z",
    "source_url": "https://example.com/newsletter"
  }
}`,
    },
    related: [
      { href: "/integrations/n8n", label: "n8n" },
      { href: "/integrations/webhook", label: "Custom webhooks" },
    ],
  },
  {
    slug: "n8n",
    name: "n8n",
    category: "Automation",
    summary:
      "Self-hostable workflow automation. The Moosewave node is coming soon; use an HTTP Request node after API access is released.",
    description: [
      "The Moosewave community node is a source candidate and is not published. It remains visible here as coming soon so teams can plan without mistaking it for an installable integration.",
      "Direct HTTP workflows will use the Moosewave REST API after the API surface and credentials flow are release-approved.",
    ],
    capabilities: [
      "Self-hostable n8n node (community license)",
      "Webhook trigger receiver matches Moosewave's outbound payloads",
      "Same triggers / actions surface as the Zapier app",
      "OpenAPI spec for hand-rolled workflows",
    ],
    setupSteps: [
      {
        title: "Install the Moosewave n8n node",
        body: "Coming soon. The Moosewave n8n package is not published yet.",
      },
      {
        title: "Add Moosewave credentials",
        body: "Create an API key in Moosewave (Settings → API keys → New, scoped to 'n8n'). Add it as Moosewave credentials in n8n.",
      },
      {
        title: "Build a workflow",
        body: "Pick a Moosewave trigger node (e.g. 'New subscriber') or use an HTTP Request node against the REST API. Connect downstream nodes — write to Postgres, post to Slack, anything n8n supports.",
      },
    ],
    example: {
      language: "ts",
      code: `// Coming soon: planned n8n workflow with the Moosewave node
{
  "nodes": [
    { "type": "moosewave.trigger", "event": "subscriber.created" },
    { "type": "postgres", "operation": "insert", "table": "leads" }
  ],
  "connections": [["moosewave.trigger", "postgres"]]
}`,
    },
    runtimeHoldCode: "n8n_node_release_held",
    related: [
      { href: "/integrations/zapier", label: "Zapier" },
      { href: "/integrations/webhook", label: "Custom webhooks" },
    ],
  },
  {
    slug: "webhook",
    name: "Custom webhook",
    category: "Automation",
    summary:
      "Subscribe to Moosewave events from any HTTPS endpoint. Signed payloads, retries with exponential backoff.",
    description: [
      "If Slack, Discord, Teams, Zapier, and n8n don't fit — or you want a self-hosted receiver — register a raw webhook endpoint and receive Moosewave events directly.",
      "Every payload is signed with HMAC-SHA256 using a per-endpoint secret. We retry failed deliveries with exponential backoff (10s, 30s, 2m, 10m, 1h, 6h, 24h) and surface delivery state in the dashboard. After 7 days of failures we pause the endpoint and email you.",
    ],
    capabilities: [
      "HMAC-SHA256 signed payloads",
      "Exponential-backoff retries up to 7 days",
      "Per-endpoint event-type filtering",
      "Replay events from the dashboard for debugging",
    ],
    setupSteps: [
      {
        title: "Register your endpoint",
        body: "Settings → Webhooks → New endpoint. Provide an HTTPS URL and pick which event types to subscribe to.",
      },
      {
        title: "Verify signatures",
        body: "We give you a per-endpoint secret. Verify the Moosewave-Signature header on every request to ensure the payload came from us.",
      },
      {
        title: "Replay if needed",
        body: "If your endpoint had downtime, the dashboard lets you replay missed events from the last 7 days against a healthy endpoint.",
      },
    ],
    example: {
      language: "ts",
      code: `import crypto from "node:crypto";

// Express handler
app.post("/moosewave-webhook", (req, res) => {
  const signature = req.header("Moosewave-Signature") ?? "";
  const expected = crypto
    .createHmac("sha256", process.env.WEBHOOK_SECRET!)
    .update(req.rawBody)
    .digest("hex");

  if (!crypto.timingSafeEqual(
    Buffer.from(signature), Buffer.from(expected),
  )) {
    return res.status(401).end();
  }

  // Trust + handle the event. Avoid logging full payloads because they
  // can include contact and campaign data.
  req.log?.info?.({ type: req.body.type }, "moosewave webhook received");
  res.status(204).end();
});`,
    },
    related: [
      { href: "/integrations/slack", label: "Slack" },
      { href: "/integrations/zapier", label: "Zapier" },
    ],
  },
  {
    slug: "mcp",
    name: "Claude / MCP source candidate",
    category: "AI",
    summary: `Review the ${MCP_SOURCE_CANDIDATE_LABEL}; distribution and runnable setup are release-held.`,
    description: [
      MCP_RELEASE_STATUS_COPY,
      "The MIT-licensed repository contains a proxy candidate for review. Its catalogue is not evidence of installed package contents, hosted availability, protocol qualification, tenant isolation, or callable operations.",
    ],
    capabilities: [
      "MIT-licensed source candidate",
      "Mutable catalogue inspection only",
      "No production install or working-key setup",
      "No hosted/OAuth connector or cross-client compatibility claim",
    ],
    setupSteps: [
      {
        title: "Review the release hold",
        body: `${MCP_RELEASE_HOLD_CODE} blocks production setup guidance until a new immutable artifact and deployment are qualified.`,
      },
      {
        title: "Inspect source provenance",
        body: `The generated catalogue contains ${MCP_SOURCE_CANDIDATE_LABEL}; do not treat that count as installed discovery.`,
      },
      {
        title: "Wait for release evidence",
        body: "Required evidence includes artifact parity, complete scope/output classification, hosted authorization and tenant isolation, and protocol lifecycle qualification.",
      },
    ],
    example: {
      language: "json",
      code: `{
  "status": "${MCP_RELEASE_HOLD_CODE}",
  "supportedSetup": false,
  "catalogProvenance": "mutable_source_candidate"
}`,
    },
    related: [
      { href: "/mcp", label: "About the MCP surface" },
      { href: "/integrations/webhook", label: "Custom webhooks" },
    ],
  },

  // ─── Advertising ───────────────────────────────────────────────────────
  // Audience-activation destinations. Moosewave hashes member emails to
  // SHA-256 and ships them to an *existing* audience on the ad network.
  // Meta, Google Ads Data Manager, TikTok Customer File, LinkedIn, and Snap
  // have attached request-shape runtimes; non-Meta paths remain gated on live
  // provider approval/verification before full promotion.
  {
    slug: "meta-ads",
    name: "Meta Ads",
    category: "Advertising",
    summary:
      "Sync a Moosewave audience to a Meta Custom Audience. Emails are SHA-256 hashed before they leave Moosewave.",
    description: [
      "Connect a Meta ad account and pick an existing Custom Audience as the destination. Moosewave hashes each member's email to SHA-256 and ships it to Meta's Graph API (v25.0) as an EMAIL_SHA256 payload against the audience's users endpoint. The raw email never leaves Moosewave.",
      "This is a one-direction activation: we add members to an audience you already created in Meta Ads Manager — we don't create audiences for you. Members are filtered through your activation firewall first, so anyone who hasn't consented to ad targeting is withheld before any call to Meta.",
    ],
    capabilities: [
      "Adds members to an existing Meta Custom Audience",
      "Email hashed to SHA-256 (EMAIL_SHA256) before send",
      "Live delivery via Meta Graph API v25.0",
      "Activation firewall filters non-consenting members first",
    ],
    setupSteps: [
      {
        title: "Connect your Meta ad account",
        body: "From Audiences → Destinations → Meta, authorize access and supply the Custom Audience ID you want to populate. Credentials are stored as a reference, never inline.",
      },
      {
        title: "Map a Moosewave audience",
        body: "Choose which Moosewave segment feeds the destination. Only members with email and ad-targeting consent are eligible.",
      },
      {
        title: "Run a sync",
        body: "Trigger a sync from the dashboard. Moosewave hashes eligible emails and POSTs them to the audience users endpoint, then reports how many EMAIL_SHA256 members were delivered.",
      },
    ],
    example: {
      language: "json",
      code: `// Moosewave POSTs to Meta Graph API:
//   POST https://graph.facebook.com/v25.0/{audience_id}/users
{
  "schema": ["EMAIL_SHA256"],
  "data": [
    ["d4c74594d841139328695756648b6bd6…"],
    ["a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6…"]
  ]
}
// Response is summarized as:
//   "Synced 2 EMAIL_SHA256 members to Meta Custom Audience."`,
    },
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/google-ads", label: "Google Ads" },
      { href: "/integrations/linkedin-ads", label: "LinkedIn Ads" },
    ],
  },
  {
    slug: "google-ads",
    name: "Google Ads",
    category: "Advertising",
    summary:
      "A Customer Match destination for Moosewave audiences using Google's Data Manager add/remove path with stored request-status evidence.",
    description: [
      "Google Ads Customer Match is set up as an audience destination: you supply a customer ID, user list ID, credential reference, explicit ad-user-data and ad-personalization consent values, and a Customer Match terms acknowledgement. Moosewave filters targeted-ads consent, hashes deliverable emails as SHA-256 HEX, and sends Google's Data Manager audienceMembers:ingest request shape by default.",
      "Moosewave stores Data Manager requestIds as provider evidence, polls request status in the background, and can send explicit audienceMembers:remove cleanup batches. Live account validation remains certification work; legacy OfflineUserDataJob lifecycle coverage is a separate gated fallback.",
    ],
    capabilities: [
      "Customer Match Data Manager configuration + validation",
      "Requires explicit ad-user-data and ad-personalization consent values",
      "Members sent as SHA-256 HEX hashed-email identifiers after consent filtering",
      "Data Manager requestId evidence plus on-demand/background request-status diagnostics",
      "Explicit member-removal batches through Data Manager audienceMembers:remove",
      "Legacy OfflineUserDataJob path remains gated for allowlisted existing integrations",
    ],
    setupSteps: [
      {
        title: "Provide Data Manager details",
        body: "From Audiences → Destinations → Google Ads, supply the customer ID, user list ID, credential reference, Customer Match terms acknowledgement, and the two required consent values.",
      },
      {
        title: "Validate the destination",
        body: "Moosewave checks the configuration, rejects raw tokens or provider host overrides, and surfaces exactly what's missing if anything is.",
      },
      {
        title: "Review provider evidence",
        body: "After a sync, job history records the provider request ID when Google returns one, and diagnostics can retrieve Data Manager request status on demand.",
      },
    ],
    example: {
      language: "json",
      code: `// Google Ads Customer Match destination config in Moosewave:
{
  "destination": "google_ads",
  "customer_id": "123-456-7890",
  "user_list_id": "987654321",
  "customer_match_transport": "data_manager",
  "customer_match_terms_accepted": true,
  "credential_ref": "vault://integrations/google-ads/data-manager",
  "ad_user_data_consent": "GRANTED",
  "ad_personalization_consent": "GRANTED"
}
// Sync history stores Google's requestId as external_job_id when returned.`,
    },
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/meta-ads", label: "Meta Ads" },
      { href: "/integrations/tiktok-ads", label: "TikTok Ads" },
    ],
  },
  {
    slug: "tiktok-ads",
    name: "TikTok Ads",
    category: "Advertising",
    summary:
      "A TikTok Customer File audience destination with multipart upload, consent filtering, and custom-audience create/update calls.",
    description: [
      "TikTok custom-audience sync is wired as a destination keyed on your advertiser ID and either an existing audience ID or a new custom audience name, authenticated with a TikTok access token reference.",
      "Moosewave applies the targeted-ads consent firewall, hashes deliverable emails as SHA-256, uploads a Customer File through TikTok's multipart DMP endpoint, and then calls custom-audience update or create. Live advertiser certification, quota validation, status polling, and provider cleanup evidence remain before promotion.",
    ],
    capabilities: [
      "Custom-audience destination keyed on advertiser + audience ID or name",
      "Access-token reference auth (token never stored inline)",
      "Multipart DMP Customer File upload with SHA-256 email rows",
      "Custom-audience update/create after upload",
      "Live certification and cleanup evidence still required",
    ],
    setupSteps: [
      {
        title: "Configure the destination",
        body: "From Audiences → Destinations → TikTok, supply the advertiser ID, an audience ID for updates or a custom audience name for first-time creation, and an access-token reference.",
      },
      {
        title: "Validate",
        body: "Moosewave validates the configuration shape, rejects raw tokens or provider host overrides, and reports what's missing if anything is.",
      },
      {
        title: "Review live certification",
        body: "Sync job history records provider HTTP errors and delivery counts; live TikTok advertiser certification, quotas, status polling, and cleanup posture still gate promotion.",
      },
    ],
    example: {
      language: "json",
      code: `// TikTok custom-audience destination config in Moosewave:
{
  "destination": "tiktok",
  "advertiser_id": "7000000000000000000",
  "audience_id": "1700000000000000",
  "credential_ref": "vault://integrations/tiktok/audience",
  "action": "APPEND"
}
// New audiences can pass custom_audience_name instead of audience_id.`,
    },
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/meta-ads", label: "Meta Ads" },
      { href: "/integrations/snapchat-ads", label: "Snapchat Ads" },
    ],
  },
  {
    slug: "linkedin-ads",
    name: "LinkedIn Ads",
    category: "Advertising",
    summary:
      "Sync a Moosewave audience to a LinkedIn Matched Audience with chunked SHA-256 email delivery.",
    description: [
      "Connect a LinkedIn ad account and target an existing DMP Segment (Matched Audience). Moosewave hashes each member's email to SHA-256 — with whitespace removed to match LinkedIn's normalization — and ships them to the LinkedIn Marketing API dmpSegments users endpoint as a BATCH_CREATE of ADD operations.",
      "Each LinkedIn request carries up to 5,000 identifiers, so larger eligible audiences are split into sequential capped requests with batch counts and partial-failure evidence. Members pass through your activation firewall before any call to LinkedIn, and live promotion still depends on Audiences-program approval and account validation.",
    ],
    capabilities: [
      "Adds members to an existing LinkedIn DMP Segment",
      "Email hashed to SHA-256 with whitespace removed",
      "Live delivery via LinkedIn Marketing API (BATCH_CREATE)",
      "Sequential 5,000-identifier request chunking",
    ],
    setupSteps: [
      {
        title: "Connect LinkedIn",
        body: "From Audiences → Destinations → LinkedIn, authorize the account and supply the DMP Segment ID. The integration also checks that your account is approved for the audiences program.",
      },
      {
        title: "Map an audience",
        body: "Choose a Moosewave segment or list. Runs above LinkedIn's per-request cap are split into sequential 5,000-identifier requests.",
      },
      {
        title: "Run a sync",
        body: "Moosewave hashes eligible emails and POSTs them as ADD elements to the dmpSegments users endpoint, then reports how many were delivered.",
      },
    ],
    example: {
      language: "json",
      code: `// Moosewave POSTs to LinkedIn Marketing API:
//   POST https://api.linkedin.com/rest/dmpSegments/{segment_id}/users
{
  "elements": [
    {
      "action": "ADD",
      "userIds": [
        { "idType": "SHA256_EMAIL", "idValue": "d4c74594d841139…" }
      ]
    }
  ]
}
// Moosewave splits larger syncs into sequential 5,000-element requests.`,
    },
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/meta-ads", label: "Meta Ads" },
      { href: "/integrations/google-ads", label: "Google Ads" },
    ],
  },
  {
    slug: "snapchat-ads",
    name: "Snapchat Ads",
    category: "Advertising",
    summary:
      "Sync a Moosewave audience to a Snapchat audience segment with chunked SHA-256 email delivery.",
    description: [
      "Connect a Snap ad account and target an existing audience segment. Moosewave hashes each member's email to SHA-256 and ships it to the Snap Marketing API (v1) segments users endpoint with an EMAIL_SHA256 schema. The raw email never leaves Moosewave.",
      "This adds members to a segment you already created in Snap. Members pass through your activation firewall before any call to Snap, and runs above Snap's 100,000-user request cap split into sequential requests with request-id, batch-count, and partial-failure evidence. Live promotion still depends on account validation and provider-side status/cleanup certification.",
    ],
    capabilities: [
      "Adds members to an existing Snapchat audience segment",
      "Email hashed to SHA-256 (EMAIL_SHA256) before send",
      "Live delivery via Snap Marketing API v1",
      "Sequential 100,000-identifier request chunking",
      "Activation firewall filters non-consenting members first",
    ],
    setupSteps: [
      {
        title: "Connect your Snap ad account",
        body: "From Audiences → Destinations → Snapchat, authorize access and supply the ad account ID and the segment ID you want to populate.",
      },
      {
        title: "Map a Moosewave audience",
        body: "Choose which Moosewave segment or list feeds the destination. Only members with email and ad-targeting consent are eligible.",
      },
      {
        title: "Run a sync",
        body: "Moosewave hashes eligible emails, POSTs them to the segment users endpoint in capped batches, then reports delivered members, request IDs, and partial failures.",
      },
    ],
    example: {
      language: "json",
      code: `// Moosewave POSTs to Snap Marketing API:
//   POST https://adsapi.snapchat.com/v1/segments/{segment_id}/users
{
  "users": [
    {
      "schema": ["EMAIL_SHA256"],
      "data": [["d4c74594d841139328695756648b6bd6…"]]
    }
  ]
}
// Moosewave splits larger syncs into sequential 100,000-user requests.`,
    },
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/meta-ads", label: "Meta Ads" },
      { href: "/integrations/tiktok-ads", label: "TikTok Ads" },
    ],
  },

  // ─── Commerce (additional storefronts + payment processors) ────────────
  {
    slug: "bigcommerce",
    name: "BigCommerce",
    category: "Commerce",
    summary:
      "Sync BigCommerce customers, products, and orders into Moosewave for post-purchase and re-engagement flows.",
    description: [
      "The BigCommerce integration syncs customers, products (with variants), and orders into Moosewave so you can run post-purchase and re-engagement automations without a second ESP. It runs both ways: a one-time backfill (customers, then products, then orders) and ongoing webhook events for new activity.",
      "We respect marketing consent: a customer is treated as marketable when they accept marketing or abandoned-cart emails in BigCommerce. Auth is a stored BigCommerce access token; it's held as a reference, not inline.",
    ],
    capabilities: [
      "Customer, product (with variants), and order sync",
      "Backfill plus ongoing webhook events",
      "Respects accepts-marketing / abandoned-cart consent",
      "Per-store access-token auth",
    ],
    setupSteps: [
      {
        title: "Connect your BigCommerce store",
        body: "Settings → Integrations → BigCommerce. Provide the store hash and an access token with read scopes on customers, products, and orders.",
      },
      {
        title: "Run a backfill",
        body: "Moosewave backfills customers, then products, then orders. Marketing-consenting customers become subscribers; the rest are stored without marketing flags.",
      },
      {
        title: "Verify webhooks",
        body: "Moosewave registers the store webhooks so new orders and customers flow in continuously. Trigger a test order to confirm the event lands.",
      },
    ],
    example: {
      language: "json",
      code: `// BigCommerce order webhook → Moosewave automation trigger
{
  "trigger": "bigcommerce.order.created",
  "customer": { "accepts_marketing": true },
  "products": ["sku_starter_kit"],
  "total_inc_tax": 64.00
}`,
    },
    related: [
      { href: "/commerce", label: "Commerce" },
      { href: "/integrations/shopify", label: "Shopify" },
      { href: "/integrations/stripe", label: "Stripe" },
    ],
  },
  {
    slug: "adobe-commerce",
    name: "Adobe Commerce (Magento)",
    category: "Commerce",
    summary:
      "Sync Adobe Commerce / Magento customers, products, orders, and refunds into Moosewave. SaaS and self-hosted both work.",
    description: [
      "Adobe Commerce — the platform formerly and still widely known as Magento — syncs customers, products, and orders into Moosewave, plus credit memos as refund events. It works against both Adobe Commerce Cloud (SaaS) and self-hosted Magento installs; you tell us which deployment mode you're on.",
      "Sync runs as a backfill (customers, then products, then orders, then credit memos) and via webhooks for ongoing activity. Auth is a bearer access token, optionally paired with a webhook secret, against your store's API base URL. Marketing consent uses the store's accepts-marketing flag.",
    ],
    capabilities: [
      "Customer, product, and order sync",
      "Credit memos captured as refund events",
      "Adobe Commerce Cloud (SaaS) or self-hosted Magento",
      "Backfill plus webhook-driven updates",
    ],
    setupSteps: [
      {
        title: "Provide API access",
        body: "Settings → Integrations → Adobe Commerce. Supply the API base URL, a bearer access token, your deployment mode (cloud or self-hosted), and an optional webhook secret.",
      },
      {
        title: "Backfill the catalog and customers",
        body: "Moosewave backfills customers, products, orders, and credit memos in that order. Custom attributes are flattened onto the records we ingest.",
      },
      {
        title: "Wire webhooks",
        body: "Point your store's webhooks at Moosewave to stream new orders and refunds. Send a test event to confirm signature verification passes.",
      },
    ],
    example: {
      language: "json",
      code: `// Adobe Commerce credit memo → Moosewave refund event
{
  "event": "adobe_commerce.creditmemo.created",
  "order_increment_id": "000000142",
  "customer_email": "ada@example.com",
  "refunded_total": 64.00
}`,
    },
    related: [
      { href: "/commerce", label: "Commerce" },
      { href: "/integrations/shopify", label: "Shopify" },
      { href: "/integrations/bigcommerce", label: "BigCommerce" },
    ],
  },
  {
    slug: "paypal",
    name: "PayPal",
    category: "Commerce",
    summary:
      "Sync PayPal transactions into Moosewave as orders, with payer info as customers. A payments source, not a storefront.",
    description: [
      "PayPal is a payments source rather than a storefront, and we treat it that way. Moosewave pulls completed transactions — via PayPal's transaction reporting API over a rolling window and via webhooks for live activity — and records them as orders, with the payer's contact info captured as a customer. Refunds are recorded as events, not as separate orders.",
      "There's no product catalog here, and PayPal doesn't carry a marketing-consent signal, so synced payers are not auto-marked marketable — segment them deliberately. Auth is OAuth2 client-credentials (client ID and secret) plus a webhook ID, scoped to a live or sandbox environment.",
    ],
    capabilities: [
      "Transactions synced as orders; payer info as customers",
      "Refunds captured as events (not orders)",
      "Backfill over a rolling transaction window plus webhooks",
      "OAuth2 client-credentials auth (no marketing-consent signal)",
    ],
    setupSteps: [
      {
        title: "Create REST API credentials",
        body: "In your PayPal developer dashboard, create an app and copy its client ID and secret. Settings → Integrations → PayPal in Moosewave: paste them and pick live or sandbox.",
      },
      {
        title: "Backfill recent transactions",
        body: "Moosewave pulls transactions over a rolling window (PayPal limits this to about a month per query) and records them as orders with payer customers.",
      },
      {
        title: "Subscribe to webhooks",
        body: "Add Moosewave's webhook URL in PayPal and supply the webhook ID. Completed-order and refund events then stream in for automations.",
      },
    ],
    example: {
      language: "json",
      code: `// PayPal webhook → Moosewave
{
  "event_type": "CHECKOUT.ORDER.COMPLETED",
  "resource": {
    "payer": { "email_address": "ada@example.com" },
    "purchase_units": [{ "amount": { "value": "42.00" } }]
  }
}
// Recorded as an order; refunds arrive as PAYMENT.CAPTURE.REFUNDED events.`,
    },
    related: [
      { href: "/commerce", label: "Commerce" },
      { href: "/integrations/stripe", label: "Stripe" },
      { href: "/integrations/razorpay", label: "Razorpay" },
    ],
  },
  {
    slug: "razorpay",
    name: "Razorpay",
    category: "Commerce",
    summary:
      "Sync Razorpay orders and payments into Moosewave as orders, with customers from payer info. A payments source.",
    description: [
      "Razorpay is a payments processor, and Moosewave syncs it as one. We record Razorpay orders and payments as orders in Moosewave and capture payer contact info as customers; refunds come through as events rather than separate orders. Sync runs as a paginated backfill (customers, orders, payments, refunds) and via webhooks for live activity.",
      "Because Razorpay carries no marketing-consent signal, synced payers are not auto-marked marketable — segment them deliberately. Auth is HTTP Basic with your Razorpay key ID and secret, plus a webhook secret for signature verification.",
    ],
    capabilities: [
      "Orders and payments synced as orders; payers as customers",
      "Refunds captured as events (not orders)",
      "Paginated backfill plus webhook events",
      "Key-ID / secret auth with webhook signature verification",
    ],
    setupSteps: [
      {
        title: "Add your Razorpay keys",
        body: "Settings → Integrations → Razorpay. Paste your key ID and key secret, and a webhook secret for verifying inbound events.",
      },
      {
        title: "Backfill history",
        body: "Moosewave backfills customers, orders, payments, and refunds in pages. Payers become customers; payments and orders become Moosewave orders.",
      },
      {
        title: "Enable webhooks",
        body: "Point Razorpay webhooks (payment.authorized, order.paid, refund.created, …) at Moosewave. We verify each signature before processing.",
      },
    ],
    example: {
      language: "json",
      code: `// Razorpay webhook → Moosewave
{
  "event": "order.paid",
  "payload": {
    "payment": { "entity": {
      "email": "ada@example.com",
      "amount": 420000,
      "currency": "INR"
    }}
  }
}
// Recorded as an order; refund.created arrives as an event.`,
    },
    related: [
      { href: "/commerce", label: "Commerce" },
      { href: "/integrations/stripe", label: "Stripe" },
      { href: "/integrations/paypal", label: "PayPal" },
    ],
  },

  // ─── CRM ───────────────────────────────────────────────────────────────
  // Inbound, pull-only: Moosewave reads contacts/leads from the CRM into the
  // subscriber system. There is no write-back to the CRM. Only the six
  // providers with real backfill clients are listed here.
  {
    slug: "salesforce",
    name: "Salesforce",
    category: "CRM",
    summary:
      "Pull Salesforce Contacts and Leads into Moosewave via SOQL. Read-only: Moosewave never writes back to Salesforce.",
    description: [
      "The Salesforce integration pulls Contacts and Leads into Moosewave's subscriber system using SOQL queries against your org's instance URL. It's strictly inbound — Moosewave reads from Salesforce and never writes contacts or leads back.",
      "Auth is a connected-app OAuth token, held as a reference. CRM fields land as custom fields and tags on the Moosewave subscriber, so you can segment on them. The API version is configurable; we default to a recent one.",
    ],
    capabilities: [
      "Pulls Contacts and Leads via SOQL",
      "Inbound only — no write-back to Salesforce",
      "Connected-app OAuth auth (stored as a reference)",
      "CRM fields mapped to subscriber custom fields and tags",
    ],
    setupSteps: [
      {
        title: "Authorize a connected app",
        body: "Settings → Integrations → Salesforce → Connect. Authorize via your connected app; Moosewave stores the OAuth token as a reference and records your instance URL.",
      },
      {
        title: "Choose objects and fields",
        body: "Pick Contacts, Leads, or both, and map the Salesforce fields you care about to Moosewave custom fields.",
      },
      {
        title: "Run the backfill",
        body: "Moosewave runs SOQL queries in batches and upserts matching records as subscribers. Re-run any time to refresh.",
      },
    ],
    example: {
      language: "ts",
      code: `// Moosewave issues a SOQL query like:
//   SELECT Id, Email, FirstName, LastName, LeadSource
//   FROM Contact WHERE Email != null
// Each row upserts a Moosewave subscriber:
{
  "email": "ada@example.com",
  "tags": ["salesforce:contact", "source:LeadSource/Webinar"],
  "custom_fields": { "sf_contact_id": "003..." }
}`,
    },
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/hubspot", label: "HubSpot" },
      { href: "/integrations/pipedrive", label: "Pipedrive" },
    ],
  },
  {
    slug: "hubspot",
    name: "HubSpot",
    category: "CRM",
    summary:
      "Sync HubSpot CRM contacts through managed OAuth or a vaulted token reference, with bounded backfills and optional list/deal data.",
    description: [
      "This CRM integration is separate from the one-time HubSpot migration importer. It reads HubSpot contacts into Moosewave through managed OAuth or a vault-backed private-app credential reference; it does not write contacts back to HubSpot.",
      "REST backfills normalize the current primary email and standard contact fields, retain configured extra properties as HubSpot source data, and can reconcile explicitly configured list memberships or associated deal events. Contact webhooks belong to the centrally configured HubSpot OAuth app. A private-app token can run REST backfills and scheduled retries, but cannot register those app-level webhook subscriptions.",
      "Each contact uses an integration-scoped binding to its canonical HubSpot object ID; the connector does not overwrite an unrelated subscriber external ID. If a bound contact is deleted or loses its usable primary email, the binding is marked inactive and only connector-owned list memberships are detached. The subscriber is not deleted or suppressed, and its consent/status is not changed.",
    ],
    capabilities: [
      "Inbound HubSpot contact REST backfills; no contact write-back",
      "Managed OAuth or a vault-backed private-app credential reference",
      "Configured list-membership mappings and optional associated deal events",
      "OAuth app contact webhooks; token-only setups use backfill and retry",
      "Scoped identity and membership reconciliation without changing subscriber consent",
    ],
    setupSteps: [
      {
        title: "Choose the credential path",
        body: "Use the managed HubSpot OAuth connection when available. An administrator can instead provide a vault credential reference for a private-app token; that token is never returned by the integration API.",
      },
      {
        title: "Configure the bounded sync",
        body: "Choose any extra contact properties, explicit HubSpot list IDs and Moosewave list mappings, and whether associated deal events should be read. Unconfigured lists and fields are not inferred.",
      },
      {
        title: "Backfill and verify continuity",
        body: "Run the paginated REST backfill and inspect its durable retry state. Verify the integration-scoped contact bindings and connector-owned list memberships. Managed OAuth installations can receive the app's signed contact webhooks; private-app-only setups rely on scheduled backfill and retry.",
      },
    ],
    example: {
      language: "json",
      code: `// Illustrative normalized HubSpot CRM contact
{
  "source_id": "hubspot://contact/1015",
  "email": "ada@example.com",
  "tags": ["hubspot"],
  "lifecycle_stage": "customer",
  "properties": {
    "hubspot_object_id": "1015",
    "hubspot_raw": {
      "lifecyclestage": "customer"
    }
  }
}`,
    },
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/salesforce", label: "Salesforce" },
      { href: "/integrations/pipedrive", label: "Pipedrive" },
    ],
  },
  {
    slug: "pipedrive",
    name: "Pipedrive",
    category: "CRM",
    summary:
      "Pull Pipedrive persons, deals, organizations, and activities into Moosewave. Read-only with managed webhooks.",
    description: [
      "The Pipedrive integration pulls persons, deals, organizations, and activities into Moosewave via Pipedrive's v2 REST API. Persons become subscribers; deals, organizations, and activities can drive events and automation triggers. It's inbound only — Moosewave reads from Pipedrive and does not write back.",
      "Auth supports OAuth2 (with token refresh) or an API token, held as a reference. Managed webhooks — registered and owned by Moosewave — keep records current after the initial backfill. Deals, organizations, and activities are optional and toggled in settings.",
    ],
    capabilities: [
      "Pulls persons, deals, organizations, and activities (v2 REST)",
      "Inbound only — no write-back to Pipedrive",
      "OAuth2 with token refresh, or API token",
      "Managed webhooks; deals/orgs/activities optional",
    ],
    setupSteps: [
      {
        title: "Connect Pipedrive",
        body: "Settings → Integrations → Pipedrive → Connect. Authorize via OAuth or paste an API token. Choose whether to include deals, organizations, and activities.",
      },
      {
        title: "Map persons to subscribers",
        body: "Moosewave upserts persons as subscribers and maps their fields to custom fields and tags. Deals and activities feed events.",
      },
      {
        title: "Backfill and subscribe",
        body: "Run the backfill, after which Moosewave registers managed webhooks so new persons and deal changes stream in.",
      },
    ],
    example: {
      language: "json",
      code: `// Pipedrive person → Moosewave subscriber
{
  "email": "ada@example.com",
  "tags": ["pipedrive:person"],
  "custom_fields": {
    "pd_person_id": "42",
    "pd_org": "Lovelace Labs"
  }
}`,
    },
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/hubspot", label: "HubSpot" },
      { href: "/integrations/salesforce", label: "Salesforce" },
    ],
  },
  {
    slug: "zoho-crm",
    name: "Zoho CRM",
    category: "CRM",
    summary:
      "Pull Zoho CRM Contacts and Leads into Moosewave via the v8 REST API. Read-only and data-center aware.",
    description: [
      "The Zoho CRM integration pulls Contacts and Leads into Moosewave's subscriber system using the Zoho CRM v8 REST API. It's inbound only — Moosewave reads from Zoho and does not write back.",
      "Auth is an OAuth2 access token held as a reference. The integration is data-center aware (US, EU, IN, AU, JP), so it talks to the right Zoho region. Standard and optional custom fields map onto Moosewave subscriber custom fields and tags.",
    ],
    capabilities: [
      "Pulls Contacts and Leads via Zoho CRM v8 REST",
      "Inbound only — no write-back to Zoho",
      "Data-center aware (US, EU, IN, AU, JP)",
      "OAuth2 auth; optional custom fields mapped",
    ],
    setupSteps: [
      {
        title: "Authorize Zoho",
        body: "Settings → Integrations → Zoho CRM → Connect. Authorize via OAuth and select your Zoho data center.",
      },
      {
        title: "Choose objects and fields",
        body: "Pick Contacts, Leads, or both, and map standard and custom fields to Moosewave.",
      },
      {
        title: "Run the backfill",
        body: "Moosewave pages through records (capped at Zoho's 200-per-page limit) and upserts them as subscribers.",
      },
    ],
    example: {
      language: "json",
      code: `// Zoho CRM contact → Moosewave subscriber
{
  "email": "ada@example.com",
  "tags": ["zoho:contact"],
  "custom_fields": {
    "zoho_id": "554000",
    "lead_source": "Webinar"
  }
}`,
    },
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/hubspot", label: "HubSpot" },
      { href: "/integrations/keap", label: "Keap" },
    ],
  },
  {
    slug: "dynamics-365",
    name: "Microsoft Dynamics 365",
    category: "CRM",
    summary:
      "Pull Dynamics 365 Contacts and Leads from Dataverse into Moosewave via the Web API. Read-only and Entra-authed.",
    description: [
      "The Dynamics 365 integration pulls Contacts and Leads from Dataverse into Moosewave's subscriber system using the Dataverse Web API (v9.2). It's inbound only — Moosewave reads from Dynamics and does not write back.",
      "Auth is OAuth2 via Microsoft Entra, held as a reference, scoped to your environment URL. Optional business-unit filtering narrows which records sync. Pulled fields map to Moosewave subscriber custom fields and tags.",
    ],
    capabilities: [
      "Pulls Contacts and Leads from Dataverse (Web API v9.2)",
      "Inbound only — no write-back to Dynamics",
      "Microsoft Entra OAuth2 auth, scoped to an environment URL",
      "Optional business-unit filtering",
    ],
    setupSteps: [
      {
        title: "Connect via Entra",
        body: "Settings → Integrations → Dynamics 365 → Connect. Authorize through Microsoft Entra and supply your environment URL.",
      },
      {
        title: "Scope the records",
        body: "Optionally filter by business unit, then choose Contacts, Leads, or both and map their fields.",
      },
      {
        title: "Run the backfill",
        body: "Moosewave pages through Dataverse (up to its 5,000-row page size) and upserts matching records as subscribers.",
      },
    ],
    example: {
      language: "json",
      code: `// Dynamics 365 contact → Moosewave subscriber
{
  "email": "ada@example.com",
  "tags": ["dynamics365:contact"],
  "custom_fields": {
    "d365_contactid": "00000000-0000-0000-0000-000000000000"
  }
}`,
    },
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/salesforce", label: "Salesforce" },
      { href: "/integrations/hubspot", label: "HubSpot" },
    ],
  },
  {
    slug: "keap",
    name: "Keap",
    category: "CRM",
    summary:
      "Pull Keap contacts into Moosewave via the REST v2 API. Read-only, with OAuth or API-key auth.",
    description: [
      "The Keap integration pulls contacts into Moosewave's subscriber system using the Keap REST v2 API. It's inbound only — Moosewave reads contacts from Keap and does not write back.",
      "Auth is flexible: OAuth2, an API key, a personal access token, or a service-account key — all held as a reference. Optional tag filtering limits which Keap contacts sync. Contact fields map onto Moosewave subscriber custom fields and tags.",
    ],
    capabilities: [
      "Pulls contacts via the Keap REST v2 API",
      "Inbound only — no write-back to Keap",
      "OAuth2, API key, PAT, or service-account auth",
      "Optional tag filtering on which contacts sync",
    ],
    setupSteps: [
      {
        title: "Connect Keap",
        body: "Settings → Integrations → Keap → Connect. Authorize via OAuth or paste an API key / personal access token.",
      },
      {
        title: "Filter and map",
        body: "Optionally restrict to specific Keap tags, then map contact fields to Moosewave custom fields.",
      },
      {
        title: "Run the backfill",
        body: "Moosewave pages through contacts (up to REST v2's 1,000-per-page limit) and upserts them as subscribers.",
      },
    ],
    example: {
      language: "json",
      code: `// Keap contact → Moosewave subscriber
{
  "email": "ada@example.com",
  "tags": ["keap:contact", "keap-tag:vip"],
  "custom_fields": { "keap_contact_id": "770" }
}`,
    },
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/hubspot", label: "HubSpot" },
      { href: "/integrations/zoho-crm", label: "Zoho CRM" },
    ],
  },

  // ─── Support / Reviews / Loyalty ───────────────────────────────────────
  // Support discovery is catalog-only. Runtime requests are source-held.
  {
    slug: "helpdesk-ingest",
    name: "Support integration runtime held",
    category: "Support",
    summary:
      "Explore the support-provider catalog; credentials and every provider or ingest effect are release-held.",
    description: [
      "This entry is catalog exploration only. Credential handling, connection creation, ingest provisioning, sync, backfill, pause, disconnect, provider cleanup, and run history are held before admin/provider runtime effects.",
      "No support runtime request was sent. Admin/provider hold code: support_integration_runtime_held. Public callback ingress is separately held with support_provider_ingress_held.",
    ],
    capabilities: [
      "Static support-provider catalog exploration",
      "Credential handling and connection creation held",
      "Sync, backfill, ingest, and cleanup held",
      "Public callback ingress held (support_provider_ingress_held)",
      "Pause, disconnect, and run-history effects held",
    ],
    setupSteps: [
      {
        title: "Runtime unavailable",
        body: "No support connection or credential setup is release-authorized.",
      },
      {
        title: "Requests held",
        body: "Create, sync, backfill, and ingest requests remain held; public callback ingress is separately held.",
      },
      {
        title: "Catalog only",
        body: "Review reported provider entries without treating them as runtime availability.",
      },
    ],
    example: {
      language: "text",
      code: "No support runtime request is available. Admin/provider hold: support_integration_runtime_held. Public callback ingress: support_provider_ingress_held.",
    },
    runtimeHoldCode: "support_integration_runtime_held",
    callbackIngressHoldCode: "support_provider_ingress_held",
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/webhook", label: "Custom webhooks" },
      { href: "/integrations/zapier", label: "Zapier" },
    ],
  },
  {
    slug: "reviews-ingest",
    name: "Reviews ingest",
    category: "Reviews",
    summary:
      "Push product and service reviews into Moosewave via a canonical ingest API. Yotpo, Judge.me, Okendo, and more.",
    description: [
      "Moosewave registers the major reviews platforms — Yotpo, Judge.me, Okendo, Loox, Stamped, Trustpilot, Reviews.io, Bazaarvoice, and PowerReviews — with managed credential validation. The live path today is ingest-first: you POST canonical review data to Moosewave's review ingest endpoint, and we attach it to the subscriber so you can trigger flows on a new review or a low rating.",
      "Honest boundary: the registry uses Moosewave's canonical review-ingest model, and provider-native pulling and webhooks aren't wired yet. Credentials and settings validate now; automatic pull arrives when the per-provider workers ship. Until then, forward reviews via a webhook or automation tool.",
    ],
    capabilities: [
      "Canonical ingest API for product and service reviews",
      "Reviews attached to the subscriber for triggers and segments",
      "Managed credential validation for 9 registered platforms",
      "Provider-managed pull and native webhooks not live yet",
    ],
    setupSteps: [
      {
        title: "Register a reviews platform",
        body: "Settings → Integrations → Reviews. Choose your platform (e.g. Yotpo), supply its store ID and credentials, and Moosewave validates them.",
      },
      {
        title: "Push review data",
        body: "POST reviews to the review ingest endpoint — directly, or via a webhook / automation tool that forwards your platform's review events.",
      },
      {
        title: "Trigger on reviews",
        body: "Build automations on 'new review' or 'rating below threshold'. Provider-managed pull arrives later without changing your ingest payloads.",
      },
    ],
    example: {
      language: "json",
      code: `// POST to Moosewave's review ingest endpoint
{
  "provider": "yotpo",
  "object": "product_review",
  "subscriber_email": "ada@example.com",
  "data": {
    "product": "Starter Kit",
    "rating": 5,
    "title": "Loved it"
  }
}`,
    },
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/loyalty-ingest", label: "Loyalty ingest" },
      { href: "/integrations/webhook", label: "Custom webhooks" },
    ],
  },
  {
    slug: "loyalty-ingest",
    name: "Loyalty ingest",
    category: "Loyalty",
    summary:
      "Push loyalty members, points, and referral events into Moosewave via a canonical ingest API. Smile.io, LoyaltyLion, and more.",
    description: [
      "Moosewave registers the major loyalty and referral platforms — Smile.io, LoyaltyLion, Rivo, ReferralCandy, Growave, Marsello, Antavo, Friendbuy, and Talkable — with managed credential validation. The live path today is ingest-first: you POST canonical member and loyalty-event data to Moosewave's loyalty ingest endpoint, and we attach points, tiers, and referral activity to the subscriber for segmentation and automation.",
      "Honest boundary: the registry uses Moosewave's canonical loyalty-ingest model, and provider-native pulling and webhooks aren't wired yet. Credentials and settings validate now; automatic pull arrives when the per-provider workers ship. Until then, forward loyalty events via a webhook or automation tool.",
    ],
    capabilities: [
      "Canonical ingest API for members, points, tiers, and referrals",
      "Loyalty state attached to the subscriber for segments",
      "Managed credential validation for 9 registered platforms",
      "Provider-managed pull and native webhooks not live yet",
    ],
    setupSteps: [
      {
        title: "Register a loyalty platform",
        body: "Settings → Integrations → Loyalty. Choose your platform (e.g. Smile.io), supply its identifiers and credentials, and Moosewave validates them.",
      },
      {
        title: "Push member and event data",
        body: "POST members and loyalty events to the loyalty ingest endpoint — directly, or via a webhook / automation tool that forwards your platform's events.",
      },
      {
        title: "Segment on loyalty",
        body: "Use points-earned, points-redeemed, and tier-changed events as triggers and segment conditions. Provider-managed pull arrives later without changing your payloads.",
      },
    ],
    example: {
      language: "json",
      code: `// POST to Moosewave's loyalty ingest endpoint
{
  "provider": "smile",
  "object": "loyalty_event",
  "subscriber_email": "ada@example.com",
  "data": {
    "event": "points.earned",
    "points": 120,
    "vip_tier": "Gold"
  }
}`,
    },
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/reviews-ingest", label: "Reviews ingest" },
      { href: "/integrations/webhook", label: "Custom webhooks" },
    ],
  },

  // ─── Analytics ─────────────────────────────────────────────────────────
  {
    slug: "analytics-ingest",
    name: "Analytics ingest",
    category: "Analytics",
    summary:
      "Push profiles and events from GA4, Segment, Amplitude, Mixpanel, PostHog, and 25+ more into Moosewave.",
    description: [
      "Moosewave registers a wide catalog of analytics and product-intelligence sources — Google Analytics 4, Segment, RudderStack, Amplitude, Mixpanel, PostHog, Heap, FullStory, Adobe Analytics, and many more. The model is inbound ingest: these tools push profiles and events to Moosewave via a sync API or webhook ingest endpoint, and we upsert them as profile and event signals you can segment and automate on.",
      "To be precise about direction: Moosewave receives data from these sources rather than pulling reports out of them. Each provider has a managed credential reference (write key, project token, API secret, and so on). The catalog uses one canonical Moosewave analytics-ingest model.",
    ],
    capabilities: [
      "Ingests profiles and events from 30+ analytics sources",
      "Inbound: tools push to Moosewave (we don't pull reports out)",
      "Managed credential references per provider",
      "Signals usable as segment conditions and automation triggers",
    ],
    setupSteps: [
      {
        title: "Register an analytics source",
        body: "Settings → Integrations → Analytics. Pick a source (e.g. GA4 or Segment), supply its credential reference, and Moosewave validates it.",
      },
      {
        title: "Send profiles and events",
        body: "Configure the source to forward to Moosewave's analytics sync or ingest endpoint — natively where supported, or via your CDP / automation layer.",
      },
      {
        title: "Use the signals",
        body: "Segment and trigger automations on ingested events and profile traits. Add more sources without changing your downstream segments.",
      },
    ],
    example: {
      language: "json",
      code: `// POST to Moosewave's analytics ingest endpoint
{
  "provider": "segment",
  "type": "track",
  "subscriber_email": "ada@example.com",
  "event": "Product Viewed",
  "properties": { "sku": "starter-kit", "price": 64.0 }
}`,
    },
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/warehouse-export", label: "Warehouse export" },
      { href: "/integrations/webhook", label: "Custom webhooks" },
    ],
  },
  {
    slug: "warehouse-export",
    name: "Warehouse & streaming export",
    category: "Analytics",
    summary:
      "Export Moosewave events and profile context to your warehouse — S3, BigQuery, Snowflake, Redshift — as Parquet or Avro.",
    description: [
      "Moosewave can ship your subscriber events and profile context out to your own warehouse rather than only pushing data in. Destinations include object storage (Amazon S3, Cloudflare R2) and SQL warehouses (Google BigQuery, Snowflake, Amazon Redshift, Databricks, Postgres), each authenticated with its own credential reference.",
      "Streaming export batches events — email, event type, campaign, link, timestamp, plus profile context like status, tags, and custom fields — into Parquet or Avro files (snappy, gzip, or zstd compression) and ships them on a schedule. Batch size is configurable; you can filter to specific event types. This is your data, in your warehouse, in an open columnar format. Azure Blob Storage is on the roadmap and not live yet.",
    ],
    capabilities: [
      "Export to S3, R2, BigQuery, Snowflake, Redshift, Databricks, Postgres",
      "Parquet or Avro output with snappy / gzip / zstd compression",
      "Event + profile-context rows, with optional event-type filters",
      "Per-destination credential references; Azure Blob is planned",
    ],
    setupSteps: [
      {
        title: "Add a warehouse connection",
        body: "Settings → Integrations → Warehouse export. Choose a destination (e.g. Snowflake or S3) and supply its credential reference and target bucket / dataset.",
      },
      {
        title: "Choose format and batching",
        body: "Pick Parquet or Avro, a compression codec, a batch size, and any event-type filters you want applied before export.",
      },
      {
        title: "Let it stream",
        body: "Moosewave batches events plus profile context and ships them to your destination on schedule. Verify the first files land, then query them in your warehouse.",
      },
    ],
    example: {
      language: "json",
      code: `// Warehouse export connection config
{
  "provider": "snowflake",
  "format": "parquet",
  "compression": "zstd",
  "batch_size": 10000,
  "prefix": "moosewave/events/",
  "field_filters": ["open", "click", "send"]
}
// Each exported row carries event + profile context:
//   event_id, subscriber_email, event_type, campaign_id,
//   link_url, at_unix_ms, subscriber_status, tags, custom_fields`,
    },
    related: [
      { href: "/audiences", label: "Audiences" },
      { href: "/integrations/analytics-ingest", label: "Analytics ingest" },
      { href: "/integrations/webhook", label: "Custom webhooks" },
    ],
  },
];

export const INTEGRATION_CATEGORIES: IntegrationCategory[] = [
  "Communication",
  "Commerce",
  "Advertising",
  "CRM",
  "Support",
  "Reviews",
  "Loyalty",
  "Analytics",
  "Automation",
  "AI",
];

export function getIntegration(slug: string): Integration | undefined {
  return INTEGRATIONS.find((i) => i.slug === slug);
}

export function integrationsByCategory(): Record<
  IntegrationCategory,
  Integration[]
> {
  const out: Record<IntegrationCategory, Integration[]> = {
    Communication: [],
    Commerce: [],
    Advertising: [],
    CRM: [],
    Support: [],
    Reviews: [],
    Loyalty: [],
    Analytics: [],
    Automation: [],
    AI: [],
  };
  for (const i of INTEGRATIONS) {
    out[i.category].push(i);
  }
  return out;
}
