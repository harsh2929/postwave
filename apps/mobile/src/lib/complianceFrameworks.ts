/**
 * lib/complianceFrameworks.ts — the static catalogue behind the compliance
 * posture monitor.
 *
 * WHY A CLIENT-SIDE CATALOGUE AT ALL. `GET /api/v1/compliance/programs` returns
 * one row per framework and nothing else — slug, status and stamps
 * (apps/api/internal/compliance/compliance.go:72-83). It does NOT return a
 * human name, a region, a renewal cadence or a spec URL, and the server's
 * `SupportedFrameworks` list (compliance.go:60-69) is the only place the set is
 * enumerated. So the words a reader needs to understand a row have to come from
 * somewhere, and the desktop already made that call: this is the same catalogue
 * as `apps/desktop/src/components/compliance/FrameworkMeta.ts`, kept in the
 * same order and with the same wording so the two surfaces cannot disagree
 * about what "CASL" means.
 *
 * ANYTHING THE SERVER SENDS THAT IS NOT IN HERE STILL RENDERS.
 * `metaForFramework` falls back to a generic entry rather than dropping the
 * row: a framework added to `SupportedFrameworks` before this file is updated
 * must still appear, because a silently-missing framework is exactly the kind
 * of absence a compliance view exists to prevent.
 *
 * DELIBERATELY IMPORT-FREE so `compliancePosture` can be reasoned about — and
 * node-tested — without dragging react-native in.
 */

/** Slug order = the server's `SupportedFrameworks` (compliance.go:60-69). */
export const COMPLIANCE_FRAMEWORK_ORDER: readonly string[] = [
  "hipaa",
  "soc2",
  "gdpr",
  "ccpa",
  "pci_dss",
  "iso27001",
  "can_spam",
  "casl",
];

export interface ComplianceFrameworkMeta {
  slug: string;
  /** Acronym for the row. */
  short: string;
  /** Full name for the detail card. */
  full: string;
  /** One operator-facing line. Not legal advice. */
  blurb: string;
  /** Where it applies. */
  region: string;
  /**
   * The cadence the framework is normally renewed on, in months, or null when
   * the framework has no renewal at all (GDPR, CAN-SPAM and CASL are standing
   * obligations, not certificates that expire).
   *
   * This is NEVER used to compute an expiry. Only the server's `renewalAt` can
   * do that, because the cadence is what the framework says and `renewalAt` is
   * what this workspace actually recorded. Deriving "due in 12 months" from a
   * cadence would invent a date nobody set.
   */
  renewalCadenceMonths: number | null;
  /** Authoritative spec, opened in an in-app browser. "" when none. */
  url: string;
  /** What is normally in place before attesting. Reading material, not a gate. */
  gates: readonly string[];
}

export const COMPLIANCE_FRAMEWORKS: readonly ComplianceFrameworkMeta[] = [
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
      "Independent auditor attestation across Security and, optionally, Availability, Processing Integrity, Confidentiality and Privacy.",
    region: "Global · SaaS",
    renewalCadenceMonths: 12,
    url: "https://www.aicpa.org/topic/audit-assurance/soc-suite-of-services",
    gates: [
      "Auditor report (Type II) covering the current period",
      "Logical access controls documented and tested",
      "Change-management ticketing wired to deploys",
      "Vendor and subprocessor inventory current",
    ],
  },
  {
    slug: "gdpr",
    short: "GDPR",
    full: "General Data Protection Regulation",
    blurb:
      "EU/UK personal-data law. Required to process data of EU, EEA or UK subscribers.",
    region: "EU / UK",
    renewalCadenceMonths: null,
    url: "https://gdpr.eu/",
    gates: [
      "DPA signed with each subprocessor, including Moosewave",
      "DPO appointed, or a representative if outside the EU",
      "Records of processing activities (RoPA) maintained",
      "72-hour breach notification process documented",
      "Standard Contractual Clauses for cross-border transfer",
    ],
  },
  {
    slug: "ccpa",
    short: "CCPA / CPRA",
    full: "California Consumer Privacy Act with CPRA amendments",
    blurb:
      "California consumer-data law. Required if you hit CCPA thresholds and have California subscribers.",
    region: "US · California",
    renewalCadenceMonths: 12,
    url: "https://oag.ca.gov/privacy/ccpa",
    gates: [
      "Privacy policy includes CCPA-specific disclosures",
      "“Do Not Sell or Share My Personal Information” link live",
      "Subject Access Request fulfilment within 45 days",
      "Annual training for staff handling personal info",
    ],
  },
  {
    slug: "pci_dss",
    short: "PCI DSS",
    full: "Payment Card Industry Data Security Standard",
    blurb:
      "Mandatory if you process, store or transmit cardholder data. Most SaaS tools avoid PCI scope by tokenizing through a processor.",
    region: "Global · Payments",
    renewalCadenceMonths: 12,
    url: "https://www.pcisecuritystandards.org/",
    gates: [
      "Self-Assessment Questionnaire on file for your level",
      "Quarterly ASV scan reports, when required",
      "Network segmentation between CDE and non-CDE",
      "Cardholder data encrypted at rest and in transit",
    ],
  },
  {
    slug: "iso27001",
    short: "ISO 27001",
    full: "ISO/IEC 27001 — Information Security Management",
    blurb:
      "Internationally-recognised ISMS standard. Common when selling into EU or APAC enterprises.",
    region: "Global",
    renewalCadenceMonths: 36,
    url: "https://www.iso.org/standard/27001",
    gates: [
      "Statement of Applicability on file",
      "Risk assessment and treatment plan current",
      "Internal audit completed within the last 12 months",
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
      "Subject lines do not deceive about message content",
    ],
  },
  {
    slug: "casl",
    short: "CASL",
    full: "Canadian Anti-Spam Legislation",
    blurb:
      "Canadian anti-spam law. Express consent and sender identification are required for commercial electronic messages to Canadian recipients.",
    region: "Canada · Email",
    renewalCadenceMonths: null,
    url: "https://crtc.gc.ca/eng/internet/anti.htm",
    gates: [
      "Express consent records retained per subscriber",
      "Sender and contact identification in every message",
      "Unsubscribe mechanism honoured within 10 business days",
      "Sender's mailing address valid for at least 60 days",
    ],
  },
];

const META_BY_SLUG = new Map(
  COMPLIANCE_FRAMEWORKS.map((meta) => [meta.slug, meta]),
);

/** The one framework the product refuses, and the reason it gives. */
export const HIPAA_SLUG = "hipaa";

/**
 * Metadata for a slug, with a generic fallback so an unrecognised
 * server-side framework still renders instead of vanishing.
 *
 * The fallback deliberately carries an em-dash region and an empty `url`
 * rather than guessing: an invented region on a compliance row is worse than
 * an admitted blank.
 */
export function metaForFramework(slug: string): ComplianceFrameworkMeta {
  const known = META_BY_SLUG.get(slug);
  if (known) return known;
  const cleaned = (slug ?? "").trim();
  return {
    slug: cleaned,
    short: cleaned ? cleaned.toUpperCase().replace(/_/g, " ") : "Unknown",
    full: cleaned || "Unnamed framework",
    blurb:
      "This workspace tracks a framework this app does not have a description for. Open Compliance on the web admin for the full entry.",
    region: "—",
    renewalCadenceMonths: null,
    url: "",
    gates: [],
  };
}

/**
 * Catalogue position, used only as a STABLE TIEBREAK behind the urgency sort.
 * Unknown frameworks sort after every known one rather than at position 0,
 * which is what `indexOf` would give them.
 */
export function frameworkCatalogueIndex(slug: string): number {
  const index = COMPLIANCE_FRAMEWORK_ORDER.indexOf(slug);
  return index === -1 ? COMPLIANCE_FRAMEWORK_ORDER.length : index;
}
