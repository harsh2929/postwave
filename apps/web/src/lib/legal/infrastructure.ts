// SPDX-License-Identifier: AGPL-3.0-only
//
// The single source of truth for every factual claim the legal pages make about
// infrastructure, sub-processors and data location.
//
// WHY THIS FILE EXISTS. Until 2026-09-05 the privacy policy, the DPA annexes,
// the DPIA and the sub-processor register each hard-coded their own answer to
// "where does the data live". They all gave the same wrong one: Hetzner
// (Falkenstein/Nuremberg/Helsinki) for compute and Neon (Frankfurt) for
// Postgres, describing a stack that `infra/RUNBOOK_STATUS.md` records as "an
// archived Hetzner prototype… not an alternate Moosewave Cloud platform". The
// canonical target is AWS in us-west-2. Vercel was listed as the frontend host
// while apps/web builds `output: "standalone"` and deploys on AWS. AWS, the
// actual infrastructure sub-processor, was not listed at all.
//
// Four pages disagreeing with the deployment is not four bugs, it is one bug
// with four symptoms: the facts had no owner. They have one now. A legal page
// that needs to name a vendor imports it from here, and
// `subprocessor-register-is-the-only-source.test.ts` fails the build if a page
// hard-codes one instead.
//
// WHAT THIS FILE IS NOT. It is not a claim that the platform is deployed.
// RUNBOOK_STATUS.md is explicit that repository-readiness is not production
// certification, so every entry carries an `assurance` field and the pages
// render that state rather than implying a live service.

/** How much we can actually say about an entry, rather than how much we'd like to. */
export type Assurance =
  /** In the canonical deploy path and exercised by the release pipeline. */
  | "canonical"
  /** Contracted and wired, but only engaged when a customer enables the feature. */
  | "conditional"
  /** Named in the deploy contract but not yet qualified in a production account. */
  | "planned";

export type Subprocessor = {
  name: string;
  url: string;
  purpose: string;
  /** Categories of personal data the vendor can reach. "None" is a real answer. */
  data: string;
  /** Where processing happens. Must match the deploy contract, not an aspiration. */
  region: string;
  /** The transfer mechanism relied on for EU/UK personal data reaching this vendor. */
  transfer: string;
  dpa: string;
  assurance: Assurance;
};

/**
 * The deployed platform, as fixed by infra/RUNBOOK_STATUS.md ("The sole Moosewave
 * Cloud target is AWS ECS Fargate in us-west-2") and
 * infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md.
 *
 * PRIMARY_REGION is load-bearing for the Chapter V analysis. The old copy said
 * Moosewave "operates primarily from the EU", which made EU→US transfers the
 * exception. The truth inverts that: the primary region is in the United
 * States, so EVERY EU customer's data is transferred to a third country and the
 * transfer mechanism is the primary basis rather than a footnote.
 */
export const INFRASTRUCTURE = {
  cloudProvider: "Amazon Web Services",
  primaryRegion: "us-west-2 (Oregon, United States)",
  compute: "AWS ECS Fargate",
  database: "AWS RDS for PostgreSQL",
  objectStorage: "AWS S3",
  secrets: "AWS Secrets Manager with customer-managed KMS keys",
  encryptionAtRest:
    "AES-256 via AWS KMS customer-managed keys on RDS, S3 and Secrets Manager, plus application-level envelope encryption for sending credentials and campaign-assurance evidence",
  encryptionInTransit: "TLS 1.2+ on every external connection; TLS 1.3 preferred",
  edge: "Cloudflare (optional edge layer in front of the AWS origin)",
} as const;

/**
 * The version stamp the legal pages render. Bump it whenever a fact in this file
 * changes — that is what tells a customer whose DPA references a version whether
 * anything they contracted on has moved.
 */
export const LEGAL_FACTS_VERSION = "2026-09-05";

/**
 * Canonical route for the sub-processor register. Three different documents
 * previously linked three different URLs for it — /legal/subprocessors in a
 * support macro, /subprocessors in the generated DPA, /legal/sub-processors in
 * the site — and two of them 404. Anything that links it imports this.
 */
export const SUBPROCESSORS_PATH = "/legal/sub-processors";
export const TOM_PATH = "/legal/tom";

/**
 * EU/UK transfer mechanisms, spelled out once so a page cannot invent a
 * different formulation for the same vendor.
 */
export const TRANSFER = {
  /** EU-US Data Privacy Framework, where the vendor is certified. */
  dpf: "EU-US Data Privacy Framework certification, with EU Standard Contractual Clauses as the fallback mechanism",
  /** SCCs alone. */
  scc: "EU Standard Contractual Clauses (Module 3, processor to sub-processor), with the UK International Data Transfer Addendum for UK transfers",
  /** No third-country transfer occurs. */
  none: "No transfer outside the EEA for this processing",
} as const;

export const SUBPROCESSORS: readonly Subprocessor[] = [
  {
    name: "Amazon Web Services",
    url: "https://aws.amazon.com",
    purpose:
      "The platform itself: ECS Fargate compute, RDS PostgreSQL, S3 object storage, Secrets Manager, KMS, and SES for sending",
    data: "All customer and subscriber data at rest and in transit, message content, send metadata, bounce and complaint events",
    region: "United States (us-west-2)",
    transfer: TRANSFER.dpf,
    dpa: "https://aws.amazon.com/compliance/gdpr-center/",
    assurance: "canonical",
  },
  {
    name: "Cloudflare",
    url: "https://www.cloudflare.com",
    purpose: "DNS, CDN, WAF and DDoS protection in front of the AWS origin",
    data: "IP addresses, request metadata, edge cache contents",
    region: "Global edge network",
    transfer: TRANSFER.scc,
    dpa: "https://www.cloudflare.com/cloudflare-customer-dpa",
    assurance: "canonical",
  },
  {
    name: "Stripe",
    url: "https://stripe.com",
    purpose:
      "Payment processing for Moosewave subscriptions, and Stripe Connect for customers who charge for their own newsletters",
    data: "Customer billing email, payment method, transaction records. No subscriber data.",
    region: "United States, EU and UK",
    transfer: TRANSFER.dpf,
    dpa: "https://stripe.com/legal/dpa",
    assurance: "canonical",
  },
  {
    name: "Sentry",
    url: "https://sentry.io",
    purpose: "Application error tracking and crash reporting",
    data: "Stack traces and scrubbed request context. PII filters are applied before transmission.",
    region: "United States and EU",
    transfer: TRANSFER.dpf,
    dpa: "https://sentry.io/legal/dpa",
    assurance: "canonical",
  },
  {
    name: "PostHog",
    url: "https://posthog.com",
    purpose:
      "Product analytics. Off unless the visitor opts in through the cookie banner, and off unless the mobile user opts in through Settings.",
    data: "Pseudonymous user IDs, page-view and event data, feature-flag state. No subscriber data and no message content.",
    region: "EU (eu.posthog.com)",
    transfer: TRANSFER.none,
    dpa: "https://posthog.com/dpa",
    assurance: "canonical",
  },
  {
    name: "Google (Gemini API)",
    url: "https://ai.google.dev",
    purpose:
      "Generative features: campaign drafting, subject lines, the in-app assistant, the AI diagnostician and voice sequence generation",
    data: "Prompt content, which may include the customer's newsletter content and de-identified diagnostic context. Engaged only for workspaces that use AI features.",
    region: "United States and EU multi-region",
    transfer: TRANSFER.dpf,
    dpa: "https://cloud.google.com/terms/data-processing-addendum",
    assurance: "conditional",
  },
  {
    name: "OpenAI",
    url: "https://openai.com",
    purpose:
      "text-embedding-3-small for voice-fidelity scoring. Embeddings only; no generation.",
    data: "Generated draft text and reference samples, transient and not retained by OpenAI under the API terms",
    region: "United States",
    transfer: TRANSFER.dpf,
    dpa: "https://openai.com/policies/data-processing-addendum",
    assurance: "conditional",
  },
  {
    name: "Twilio",
    url: "https://www.twilio.com",
    purpose: "SMS delivery and inbound SMS handling for workspaces using the SMS channel",
    data: "Recipient phone numbers, message content, delivery and opt-out events",
    region: "United States and EU",
    transfer: TRANSFER.dpf,
    dpa: "https://www.twilio.com/legal/data-protection-addendum",
    assurance: "conditional",
  },
  {
    name: "Razorpay",
    url: "https://razorpay.com",
    purpose: "Payment processing for India-based Moosewave customers",
    data: "Customer billing email, payment method, transaction records. No subscriber data.",
    region: "India",
    transfer: TRANSFER.scc,
    dpa: "https://razorpay.com/dpa",
    assurance: "conditional",
  },
  {
    name: "HCTI (htmlcsstoimage.com)",
    url: "https://htmlcsstoimage.com",
    purpose: "Cross-client email rendering previews",
    data: "Email template HTML. No subscriber data.",
    region: "United States",
    transfer: TRANSFER.scc,
    dpa: "https://htmlcsstoimage.com/dpa",
    assurance: "conditional",
  },
  {
    name: "Postmark (ActiveCampaign)",
    url: "https://postmarkapp.com",
    purpose:
      "Optional transactional delivery, tenant sending-domain and DKIM provisioning, and dedicated-IP provisioning. Engaged only for workspaces not sending transactional mail through SES.",
    data: "Recipient email address, message content, send metadata, bounce and complaint events",
    region: "United States",
    transfer: TRANSFER.dpf,
    dpa: "https://postmarkapp.com/legal/dpa",
    assurance: "conditional",
  },
  {
    name: "Validity (SenderScore)",
    url: "https://www.validity.com",
    purpose: "Sender reputation monitoring for Inbox Reality",
    data: "Sending IP addresses and sending domains. No subscriber data.",
    region: "United States",
    transfer: TRANSFER.scc,
    dpa: "https://www.validity.com/legal",
    assurance: "conditional",
  },
];

/**
 * Vendors a legal page must never name unless they reappear in SUBPROCESSORS.
 *
 * These were published as live sub-processors while the code showed otherwise.
 * Keeping them as a denylist rather than merely deleting the paragraphs means
 * the guard test can say WHY a name is forbidden when someone pastes an old
 * version back in.
 *
 * Postmark is deliberately NOT here: it is still wired as an optional
 * transactional and domain-provisioning provider, so it stays in SUBPROCESSORS
 * as `conditional`. What was false about it was the claim that it is the
 * PRIMARY managed sending pipe — apps/api/internal/mailer/ contains exactly
 * ses.go and dev.go.
 */
export const RETIRED_VENDOR_CLAIMS: readonly { name: string; reason: string }[] = [
  { name: "Hetzner", reason: "archived prototype (infra/RUNBOOK_STATUS.md:40); never a Moosewave Cloud platform" },
  { name: "Neon", reason: "archived prototype; the canonical database is AWS RDS for PostgreSQL" },
  { name: "Vercel", reason: "never used; apps/web builds output:standalone and deploys on AWS" },
];
