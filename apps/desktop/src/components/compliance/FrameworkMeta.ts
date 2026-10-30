/**
 * FrameworkMeta — static catalogue of the compliance frameworks the
 * Compliance tab tracks. Refined Compliance PR 1.
 *
 * Each entry describes what the framework IS so an operator who
 * doesn't already know the acronym can scan the grid and orient
 * themselves. The descriptions are intentionally short and operator-
 * facing — not legal advice, just enough context to decide "yes,
 * we should attest to this".
 *
 * Adding a new framework: bump the FRAMEWORK_META array here, then
 * add the slug to compliance/SupportedFrameworks on the Go side. The
 * page renders unknown server-side frameworks with a generic fallback
 * so a new entry doesn't break the build.
 */

import type { ComplianceFramework } from "../../lib/api-client";

export interface FrameworkMeta {
  /** Slug used on the wire + as the key everywhere. */
  slug: ComplianceFramework;
  /** Acronym / short label rendered on the card. */
  short: string;
  /** Full name for the detail panel + tooltips. */
  full: string;
  /** Operator-facing one-liner. */
  blurb: string;
  /** Region the framework applies to (chip on the card). */
  region: string;
  /** Common renewal cadence so the attest form can suggest a date. */
  renewalCadenceMonths: number | null;
  /** External URL to the authoritative spec (footer link). */
  url: string;
  /** Optional gate checklist — items that should be in place before
   *  attesting. Rendered as a soft checklist; no programmatic gate. */
  gates: string[];
}

export const FRAMEWORK_META: FrameworkMeta[] = [
  {
    slug: "hipaa",
    short: "HIPAA",
    full: "Health Insurance Portability and Accountability Act",
    blurb:
      "Not supported by Moosewave. No BAA is offered; do not use the service for PHI.",
    region: "US · Healthcare",
    renewalCadenceMonths: null,
    url: "https://www.hhs.gov/hipaa/for-professionals/index.html",
    gates: [],
  },
  {
    slug: "soc2",
    short: "SOC 2",
    full: "SOC 2 Type II",
    blurb:
      "Independent auditor attestation across Security + (optionally) Availability, Processing Integrity, Confidentiality, Privacy.",
    region: "Global · SaaS",
    renewalCadenceMonths: 12,
    url: "https://www.aicpa.org/topic/audit-assurance/soc-suite-of-services",
    gates: [
      "Auditor report (Type II) covering current period",
      "Logical access controls documented + tested",
      "Change-management ticketing wired to deploys",
      "Vendor + subprocessor inventory current",
    ],
  },
  {
    slug: "gdpr",
    short: "GDPR",
    full: "General Data Protection Regulation",
    blurb:
      "EU/UK personal-data law. Required to process data of EU/EEA/UK subscribers.",
    region: "EU / UK",
    renewalCadenceMonths: null,
    url: "https://gdpr.eu/",
    gates: [
      "DPA signed with each subprocessor (incl. Moosewave)",
      "DPO appointed (or representative if outside EU)",
      "Records of processing activities (RoPA) maintained",
      "72-hour breach notification process documented",
      "Standard Contractual Clauses (SCCs) for cross-border transfer",
    ],
  },
  {
    slug: "ccpa",
    short: "CCPA / CPRA",
    full: "California Consumer Privacy Act (CCPA) + CPRA amendments",
    blurb:
      "California consumer-data law. Required if you hit CCPA thresholds + have CA subscribers.",
    region: "US · California",
    renewalCadenceMonths: 12,
    url: "https://oag.ca.gov/privacy/ccpa",
    gates: [
      "Privacy policy includes CCPA-specific disclosures",
      '"Do Not Sell or Share My Personal Information" link live',
      "Subject Access Request (SAR) fulfillment ≤ 45 days",
      "Annual training for staff handling personal info",
    ],
  },
  {
    slug: "pci_dss",
    short: "PCI DSS",
    full: "Payment Card Industry Data Security Standard",
    blurb:
      "Mandatory if you process / store / transmit cardholder data. Most SaaS tools avoid PCI scope by tokenizing through a processor.",
    region: "Global · Payments",
    renewalCadenceMonths: 12,
    url: "https://www.pcisecuritystandards.org/",
    gates: [
      "Self-Assessment Questionnaire (SAQ) on file for your level",
      "Quarterly ASV scan reports (when required)",
      "Network segmentation between CDE + non-CDE",
      "Encryption of cardholder data at rest + in transit",
    ],
  },
  {
    slug: "iso27001",
    short: "ISO 27001",
    full: "ISO/IEC 27001 — Information Security Management",
    blurb:
      "Internationally-recognized ISMS standard. Common when selling into EU/APAC enterprises.",
    region: "Global",
    renewalCadenceMonths: 36,
    url: "https://www.iso.org/standard/27001",
    gates: [
      "Statement of Applicability (SoA) on file",
      "Risk assessment + treatment plan current",
      "Internal audit completed within last 12 months",
      "Management review minutes on file",
    ],
  },
  {
    slug: "can_spam",
    short: "CAN-SPAM",
    full: "CAN-SPAM Act (US)",
    blurb:
      "US commercial-email law. Applies to every campaign you send to US recipients — non-optional for an email product.",
    region: "US · Email",
    renewalCadenceMonths: null,
    url: "https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business",
    gates: [
      "Unsubscribe link in every commercial message",
      "Unsubscribe requests honoured within 10 business days",
      "Physical postal address in every commercial message",
      "Subject lines don't deceive about message content",
    ],
  },
  {
    slug: "casl",
    short: "CASL",
    full: "Canadian Anti-Spam Legislation",
    blurb:
      "Canadian anti-spam law. Express consent + sender identification required for commercial electronic messages to Canadian recipients.",
    region: "Canada · Email",
    renewalCadenceMonths: null,
    url: "https://crtc.gc.ca/eng/internet/anti.htm",
    gates: [
      "Express consent records retained per subscriber",
      "Sender + contact identification in every message",
      "Unsubscribe mechanism honoured within 10 business days",
      "Sender's mailing address valid for at least 60 days",
    ],
  },
];

const META_BY_SLUG = new Map(FRAMEWORK_META.map((m) => [m.slug, m]));

/** Returns metadata for a slug, or a generic fallback so an
 *  unrecognised server-side framework still renders. */
export function metaFor(slug: ComplianceFramework): FrameworkMeta {
  const known = META_BY_SLUG.get(slug);
  if (known) return known;
  return {
    slug,
    short: String(slug).toUpperCase(),
    full: String(slug),
    blurb: "Compliance framework tracked by your workspace.",
    region: "—",
    renewalCadenceMonths: null,
    url: "",
    gates: [],
  };
}
