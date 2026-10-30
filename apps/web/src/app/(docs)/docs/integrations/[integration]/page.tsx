// Moosewave docs - per-integration detail page.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { JSX } from "react";

import { Breadcrumbs } from "@/components/docs/Breadcrumbs";
import { Callout } from "@/components/docs/Callout";
import { CodeBlock } from "@/components/docs/CodeBlock";

interface PageProps {
  params: Promise<{ integration: string }>;
}

interface Integration {
  slug: string;
  name: string;
  intro: string;
  features: string[];
  steps: { title: string; body: string; code?: string; lang?: string }[];
  notes?: string;
}

const INTEGRATIONS: Record<string, Integration> = {
  customerio: {
    slug: "customerio",
    name: "Customer.io",
    intro:
      "The native Customer.io surface is a partial provider-row foundation for credential-reference lifecycle, region/workspace handoff evidence, pause/disconnect state, and delegated migration run history. It is not a native Customer.io data plane, Track API writer, source-event monitor, or production certification.",
    features: [
      "App API credential references without raw keys in public provider settings",
      "US/EU region and numeric workspace handoff evidence for the delegated migration lineage",
      "Row-preserving pause/disconnect state, marketing_sync_runs history, and operator cleanup guidance",
      "Delegated customerio_handoff cursor evidence pointing to the read-only, full-snapshot migration adapter",
    ],
    steps: [
      {
        title: "Store a dedicated App API credential reference",
        body: "Create a dedicated Customer.io App API key in your secret store and pass only its credentials_ref when creating the customerio marketing-integration row. Do not use or store a Track API site ID/key here.",
      },
      {
        title: "Record region and workspace evidence",
        body: "Set region to us or eu and record the numeric workspace_id selected by the migration. The provider row records handoff metadata; the migration service separately validates /v1/workspaces and immutably binds its encrypted session to the exact region/workspace.",
      },
      {
        title: "Delegate data movement to the migration guide",
        body: "Use the Customer.io migration flow at /docs/migrations/customerio for profile, audience, preference, suppression, template, sent-newsletter, and rebuild evidence. Native sync/backfill records partial customerio_handoff run evidence; it does not independently fetch Profiles or prove completion.",
      },
      {
        title: "Pause or disconnect without erasing evidence",
        body: "Pause or disconnect the native provider row when appropriate. Disconnect preserves run history and returns cleanup guidance; it does not revoke the Customer.io App API key, stop provider workflows, mutate source data, or clean up sender/channel configuration.",
      },
      {
        title: "Keep the foundation behind promotion gates",
        body: "Do not treat this row as a native runtime or a live attestation. Promotion still requires a managed credential lifecycle, an explicit change/deletion strategy without a fictional source-event feed, any separately gated Track/Pipelines writeback, active scheduling/replay/monitoring, provider cleanup, ecosystem parity, and live workspace certification.",
      },
    ],
    notes:
      "Customer.io exposes no complete incremental profile-change feed for this contract. Every migration delta is a full snapshot, and repository tests do not replace certification against a real US/EU workspace and isolated destination.",
  },
  slack: {
    slug: "slack",
    name: "Slack",
    intro:
      "Moosewave has two separate Slack paths: incoming webhooks for selected event notifications, and an optional OAuth app for campaign approval messages and signed slash commands.",
    features: [
      "Selected event notifications through encrypted incoming-webhook URLs",
      "OAuth-backed campaign approval messages with interactive decisions",
      "Slash command: /moosewave campaigns",
      "Slash command: /moosewave send <campaign_id>",
    ],
    steps: [
      {
        title: "Configure event notifications",
        body: "In App → Integrations → Slack, paste an incoming-webhook URL, add a channel hint, and select the Moosewave event types to deliver. This path does not require OAuth.",
      },
      {
        title: "Connect the optional OAuth app",
        body: "If you need campaign approvals or slash commands, open Settings → Integrations → Slack → Connect. The bot requests chat:write, commands, channels:read, groups:read, and im:write; it does not request message history or file access.",
      },
      {
        title: "Verify the OAuth command surface",
        body: "Run /moosewave campaigns to list recent campaigns. Run /moosewave send <campaign_id> to create a send-approval request for a real campaign.",
        code: `/moosewave campaigns
/moosewave send cmp_01JXYZ`,
        lang: "bash",
      },
      {
        title: "Verify notifications separately",
        body: "Trigger one of the event types selected for the incoming-webhook connection and confirm it arrives. Disconnecting OAuth does not remove an incoming webhook, and deleting an incoming-webhook connection does not disconnect OAuth.",
      },
    ],
  },
  stripe: {
    slug: "stripe",
    name: "Stripe",
    intro:
      "The native Stripe connector reads supported customer, payment, invoice, dispute, credit-note, subscription, and refund evidence. It does not create charges, mutate paid or gift subscriptions, or provide a Stripe Customer Portal.",
    features: [
      "Restricted-key authentication through a trusted credential reference",
      "Retry-aware REST backfill for supported Stripe objects",
      "Stripe-Signature verification on the public webhook endpoint",
      "Disconnect evidence for operator-managed Stripe cleanup",
    ],
    steps: [
      {
        title: "Store credential references",
        body: "Create trusted references for a restricted Stripe read key and the webhook signing secret. Do not put raw Stripe credentials in connector JSON or CLI arguments.",
      },
      {
        title: "Create the managed commerce connection",
        body: "Pass provider stripe, your Stripe account ID, the restricted-key credential reference, and the webhook-secret reference. The CLI sends only references to the API.",
        code: `postwave integrations native create commerce \\
  --provider stripe \\
  --credential-ref vault://commerce/stripe \\
  --config '{"account_id":"acct_123","webhook_secret_ref":"vault://commerce/stripe-webhook"}'`,
        lang: "bash",
      },
      {
        title: "Run and inspect a backfill",
        body: "Start an empty managed backfill so the Stripe puller reads supported evidence, then inspect the connection run history. Keep the returned connection ID from the create response.",
        code: `postwave integrations native backfill commerce <connection_id>
postwave integrations native runs commerce <connection_id> --limit 10`,
        lang: "bash",
      },
      {
        title: "Configure the signed webhook",
        body: "In Stripe Dashboard, register https://api.moosewave.com/api/public/commerce/stripe/webhooks for the event topics shown by the provider specification. Moosewave verifies the Stripe-Signature header. Disconnecting Moosewave does not revoke the restricted key or delete the Stripe endpoint; clean those up in Stripe Dashboard.",
      },
    ],
    notes:
      "Paid and gift subscription mutations remain unavailable in this release. Treat the connector as read-only commerce evidence until a mutation contract is explicitly published.",
  },
  postmark: {
    slug: "postmark",
    name: "Postmark",
    intro:
      "Postmark is the default ESP backbone. Moosewave's Sending Settings live as Streams: Marketing for campaigns, Transactional for system emails (signups, password resets).",
    features: [
      "Stream-aware send routing (Marketing vs Transactional)",
      "Bounce + complaint webhook with signed payloads",
      "Suppression sync (Postmark suppression list ↔ Moosewave suppression list)",
      "Per-tenant stream isolation when you bring your own server-token",
    ],
    steps: [
      {
        title: "Create Postmark Streams",
        body: "In Postmark, create two Message Streams: marketing-default (Type: Broadcast) and transactional-default (Type: Transactional).",
      },
      {
        title: "Generate a server token",
        body: "Postmark Account → API Tokens. Grant the token access to both streams.",
      },
      {
        title: "Save in Moosewave",
        body: "Store the server token in your runtime secret store, then register the provider by reference. The deliverability provider config deliberately refuses raw sending credentials — post a credential_ref, not the token itself.",
        code: `curl -X POST "https://api.moosewave.com/api/v1/deliverability/providers" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "provider": "postmark",
    "display_name": "Postmark",
    "config": {
      "credential_ref": "postmark/server-token",
      "marketing_stream": "marketing-default",
      "transactional_stream": "transactional-default"
    }
  }'`,
        lang: "bash",
      },
      {
        title: "Verify the bounce webhook",
        body: "Moosewave registers https://api.moosewave.com/api/internal/feedback/postmark with HMAC verification. Send a test bounce from Postmark's webhook tester to confirm.",
      },
    ],
  },
  mailgun: {
    slug: "mailgun",
    name: "Mailgun",
    intro:
      "Use Mailgun as the sending backbone with full bounce/complaint visibility.",
    features: [
      "Domain-verified Mailgun integration",
      "Bounce / complaint / open / click webhooks",
      "Tag-based campaign attribution",
      "EU + US region selection",
    ],
    steps: [
      {
        title: "Verify your sending domain in Mailgun",
        body: "Mailgun → Sending → Domains → Add new domain. Add the SPF, DKIM, and MX records to your DNS. Wait for the green checkmark.",
      },
      {
        title: "Generate a Mailgun API key (private API key)",
        body: "Mailgun → Settings → API Keys → Private API Key.",
      },
      {
        title: "Save in Moosewave",
        body: "Store the private API key in your runtime secret store, then register the provider by reference. The deliverability provider config deliberately refuses raw sending credentials — post a credential_ref, not the key itself.",
        code: `curl -X POST "https://api.moosewave.com/api/v1/deliverability/providers" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "provider": "mailgun",
    "display_name": "Mailgun",
    "config": {
      "credential_ref": "mailgun/api-key",
      "domain": "send.example.com",
      "region": "us"
    }
  }'`,
        lang: "bash",
      },
      {
        title: "Configure the webhooks",
        body: "Create the four webhooks in Mailgun → Sending → Webhooks (delivered, permanent_fail, complained, unsubscribed) and point each at https://api.moosewave.com/api/internal/webhooks/deliverability/mailgun. Moosewave verifies every payload against your Mailgun signing key; it does not create the webhooks on your behalf.",
      },
    ],
  },
  ses: {
    slug: "ses",
    name: "Amazon SES",
    intro:
      "Bring your own AWS account. Moosewave assumes a tightly-scoped IAM role to send through your SES configuration set; bounces flow back via SNS.",
    features: [
      "Cross-account IAM role (no long-lived AWS keys)",
      "Configuration set with event-publishing enabled",
      "SNS topic for bounce / complaint notifications",
      "Region selection (us-east-1, us-west-2, eu-west-1)",
    ],
    steps: [
      {
        title: "Create an SES configuration set",
        body: "AWS Console → SES → Configuration sets → Create. Enable event publishing for Bounce, Complaint, Delivery, and route to an SNS topic.",
      },
      {
        title: "Create the IAM role",
        body: "Trust policy grants role-assumption to Moosewave's AWS account (we surface the trust JSON in the wizard). Inline policy grants ses:SendEmail, ses:SendRawEmail scoped to the configuration set ARN.",
        code: `{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["ses:SendEmail", "ses:SendRawEmail"],
    "Resource": [
      "arn:aws:ses:us-east-1:123456789012:configuration-set/postwave",
      "arn:aws:ses:us-east-1:123456789012:identity/example.com"
    ]
  }]
}`,
        lang: "json",
      },
      {
        title: "Save in Moosewave",
        body: "Register the provider with the role ARN, configuration set, region, and SNS topic ARN. These are resource identifiers rather than credentials, so they live in config directly — SES is assumed via the cross-account role, so there is no key to store.",
        code: `curl -X POST "https://api.moosewave.com/api/v1/deliverability/providers" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "provider": "ses",
    "display_name": "Amazon SES",
    "config": {
      "role_arn": "arn:aws:iam::123456789012:role/PostwaveSending",
      "configuration_set": "postwave",
      "region": "us-east-1",
      "sns_topic_arn": "arn:aws:sns:us-east-1:123456789012:postwave-events"
    }
  }'`,
        lang: "bash",
      },
      {
        title: "Verify a test send",
        body: "Moosewave sends a test email through the new role and confirms an SNS notification arrives. Reject the integration and try again if the round-trip fails.",
      },
    ],
    notes:
      "SES production access (out of sandbox) is required before going live. Open an AWS support case if your account is sandboxed.",
  },
  "custom-domains": {
    slug: "custom-domains",
    name: "Custom domains",
    intro:
      "The sending-identity API generates DKIM, SPF, and monitor-only DMARC records for a From domain, then checks the published TXT records when an operator calls the verify endpoint. This source contract does not attest provider provisioning, certificates, routing, or a live production deployment.",
    features: [
      "Generated 2048-bit DKIM public-key record with a configurable selector",
      "SPF TXT-record validation",
      "DMARC TXT-record validation with a monitor-only p=none default",
      "Explicit pending, partial, or verified evidence after an on-demand DNS check",
      "Separate legacy customer-host registration, TLS, and routing operations remain release-held",
    ],
    steps: [
      {
        title: "Add the domain",
        body: "Register a sending identity for the apex (example.com) or a sending subdomain (send.example.com). Sending identities are managed through the API. The separate Domain registry under Settings is read-only legacy ownership metadata: customer-host registration, DNS re-check, removal, TLS, and routing remain release-held.",
        code: `curl -X POST "https://api.moosewave.com/api/v1/sending-identities" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "domain": "send.example.com" }'`,
        lang: "bash",
      },
      {
        title: "Add the DNS records",
        body: "The create response returns the exact DKIM, SPF, and DMARC TXT records. Copy them into your DNS provider and use that provider's propagation evidence before asking Moosewave to verify them.",
      },
      {
        title: "Verify the records",
        body: "Verification is explicit, not polled: call POST /api/v1/sending-identities/{id}/verify once DNS has propagated. The response carries verify_state plus a per-record breakdown, so a partial failure tells you which record is still wrong. DMARC starts on a monitor-only policy and does not block enabling.",
        code: `curl -X POST "https://api.moosewave.com/api/v1/sending-identities/$IDENTITY_ID/verify" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY"`,
        lang: "bash",
      },
    ],
  },
  "inbound-webhooks": {
    slug: "inbound-webhooks",
    name: "Inbound webhooks",
    intro:
      "Ingest events from third-party systems. The upstream sender signs each request and Moosewave verifies the HMAC before persistence. Rotating an endpoint secret keeps the prior secret valid for a bounded 24-hour migration window.",
    features: [
      "Versioned HMAC-SHA256 verification over timestamp, event identity, and exact body bytes",
      "Stable event-identity de-duplication for exact upstream retries",
      "Per-endpoint secret rotation with a bounded grace window",
      "Durable bounded retry for matched Moosewave product actions",
    ],
    steps: [
      {
        title: "Register a webhook",
        body: "Open App → Inbound webhooks and create an endpoint. Moosewave returns a public /api/public/inbound/{slug} receive URL and reveals the signing secret once; configure the upstream system to send to that URL.",
      },
      {
        title: "Sign requests in the upstream sender",
        body: "The sender must set X-Postwave-Timestamp, a stable X-Postwave-Event-Id, and X-Postwave-Signature. The signed payload is length-prefixed so an event id containing a delimiter can't shift the boundaries. Moosewave rejects a body-only HMAC or a timestamp outside the five-minute window.",
        code: `// Node.js sender — payload is exactly:
//   v2:<len(timestamp)>:<timestamp>:<len(eventId)>:<eventId>:<rawBody>
const crypto = require("node:crypto");

function signForPostwave(rawBody, timestamp, eventId, secret) {
  timestamp = String(timestamp).trim();
  eventId = String(eventId).trim();

  const payload = Buffer.concat([
    Buffer.from(
      \`v2:\${Buffer.byteLength(timestamp)}:\${timestamp}:\` +
        \`\${Buffer.byteLength(eventId)}:\${eventId}:\`,
      "utf8",
    ),
    Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8"),
  ]);

  return (
    "v2=" +
    crypto.createHmac("sha256", secret).update(payload).digest("hex")
  );
}

const timestamp = Math.floor(Date.now() / 1000).toString();
const eventId = providerDeliveryId; // stable across retries
const signature = signForPostwave(rawBody, timestamp, eventId, secret);

// Send rawBody unchanged with X-Postwave-Timestamp, X-Postwave-Event-Id,
// and X-Postwave-Signature set to the three values above.`,
        lang: "javascript",
      },
      {
        title: "Inspect received events and trigger outcomes",
        body: "Open App → Inbound webhooks → <endpoint> to inspect accepted events and configured triggers. Exact upstream retries reuse the original event record instead of firing duplicate actions. Matched product actions are leased to a bounded internal retry worker; Moosewave does not control whether or when the upstream sender retries its HTTP request.",
      },
    ],
  },
};

export function generateStaticParams(): { integration: string }[] {
  return Object.keys(INTEGRATIONS).map((slug) => ({ integration: slug }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { integration } = await params;
  const i = INTEGRATIONS[integration];
  if (!i) return { title: "Integration · Moosewave docs" };
  return {
    title: `${i.name} integration · Moosewave docs`,
    description: i.intro,
    alternates: { canonical: `/docs/integrations/${i.slug}` },
  };
}

export default async function IntegrationPage({
  params,
}: PageProps): Promise<JSX.Element> {
  const { integration } = await params;
  const i = INTEGRATIONS[integration];
  if (!i) notFound();
  return (
    <article className="space-y-8">
      <Breadcrumbs
        items={[
          { label: "Docs", href: "/docs/getting-started" },
          { label: "Integrations", href: "/docs/integrations" },
          { label: i.name },
        ]}
      />

      <header className="space-y-3">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
          {i.name}
        </h1>
        <p className="text-pw-muted-on-paper max-w-3xl leading-relaxed">
          {i.intro}
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-tight">What you get</h2>
        <ul className="space-y-2">
          {i.features.map((f) => (
            <li key={f} className="flex gap-2 text-sm">
              <span
                aria-hidden
                className="mt-2 inline-block h-1 w-1 flex-none rounded-full bg-pw-ember-500"
              />
              <span className="leading-relaxed">{f}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Setup</h2>
        <ol className="space-y-4">
          {i.steps.map((s, idx) => (
            <li
              key={s.title}
              className="rounded-md border border-pw-line bg-white p-4"
            >
              <h3 className="text-sm font-semibold text-pw-ink2">
                <span className="text-pw-muted-on-paper font-mono mr-2">
                  0{idx + 1}
                </span>
                {s.title}
              </h3>
              <p className="mt-2 text-sm text-pw-muted-on-paper leading-relaxed">
                {s.body}
              </p>
              {s.code ? (
                <CodeBlock code={s.code} language={s.lang ?? "bash"} />
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      {i.notes ? (
        <Callout variant="info" title="Heads up">
          {i.notes}
        </Callout>
      ) : null}
    </article>
  );
}
