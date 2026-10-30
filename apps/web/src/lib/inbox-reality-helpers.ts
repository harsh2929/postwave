// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure, JSX-free helpers for the Inbox Reality cluster: link extraction,
// subject-length guidance, placement folding/zero-guards, risk-contribution
// math, blocklist-hit parsing, and protocol/source metadata. Kept in lib/ so
// they are unit-testable in Node and reusable across the overview, predictor
// and per-campaign report surfaces (rather than re-derived inline).

import type {
  CampaignReport,
  Placement,
  PlacementSummary,
  ProviderBreakdown,
  RiskBreakdown,
} from "./inbox-reality-types";

// -- Link extraction (predictor sends links so the reputation factor can act
//    on real destinations, not an empty list) --------------------------------

const HREF_RE = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Extract anchor destinations from an HTML string. Trims, dedupes (preserving
 * first-seen order), and drops empty / in-page (`#…`) anchors. Never throws —
 * plain text yields `[]`.
 */
export function extractLinks(html: string): string[] {
  if (typeof html !== "string" || html.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(HREF_RE)) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (!raw || raw.startsWith("#")) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= 200) break;
  }
  return out;
}

/** True when the body appears to contain HTML markup (a real tag). */
export function looksLikeHtml(body: string): boolean {
  if (typeof body !== "string") return false;
  return /<[a-z!/][^>]*>/i.test(body);
}

// -- Subject-length guidance (subject length is a real placement factor) -----

export type SubjectBand = "empty" | "short" | "ideal" | "long";

export interface SubjectAssessment {
  length: number;
  band: SubjectBand;
  tone: "ok" | "neutral" | "warn";
  message: string;
}

/**
 * Assess a subject line's length against deliverability rules of thumb: empty
 * hurts placement; ~30–55 characters render in full on most clients; over ~60
 * truncates on mobile.
 */
export function assessSubject(subject: string): SubjectAssessment {
  const length = (subject ?? "").trim().length;
  if (length === 0) {
    return {
      length,
      band: "empty",
      tone: "warn",
      message: "Add a subject line — sending without one hurts placement.",
    };
  }
  if (length <= 20) {
    return {
      length,
      band: "short",
      tone: "neutral",
      message: `Short subject (${length} chars). Aim for ~30–55 for the best open rates.`,
    };
  }
  if (length <= 60) {
    return {
      length,
      band: "ideal",
      tone: "ok",
      message: `Good length (${length} chars) — most inboxes show this in full.`,
    };
  }
  return {
    length,
    band: "long",
    tone: "warn",
    message: `Long subject (${length} chars) — mobile inboxes truncate around 40–50.`,
  };
}

// -- Placement folding + zero-guards -----------------------------------------

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/**
 * Fold a placement distribution (already expressed as fractions, e.g.
 * `overall_pct`) into {primary, promotions, spam}: updates+social → primary,
 * blocked+missing → spam. Does NOT re-normalize (inputs are already shares).
 */
export function overallPlacementSummary(
  overall: Partial<Record<Placement, number>>,
): PlacementSummary {
  const p = overall ?? {};
  return {
    primary: num(p.primary) + num(p.updates) + num(p.social),
    promotions: num(p.promotions),
    spam: num(p.spam) + num(p.blocked) + num(p.missing),
  };
}

/** Fold a Diagnosis.predicted_impact projection the same way (guards nulls). */
export function normalizePredictedImpact(
  record: Record<string, number> | null | undefined,
): PlacementSummary {
  return overallPlacementSummary((record ?? {}) as Partial<Record<Placement, number>>);
}

/** A report with no seed coverage / an all-zero distribution has no signal. */
export function isPlacementReportEmpty(
  report: Pick<CampaignReport, "total_inboxes" | "overall_pct">,
): boolean {
  if (num(report?.total_inboxes) <= 0) return true;
  const values = Object.values(report?.overall_pct ?? {});
  const sum = values.reduce<number>((acc, v) => acc + num(v), 0);
  return sum <= 0;
}

// -- Risk-contribution math (make the forecast explainable) ------------------

export type RiskBand = "low" | "medium" | "high";

const clamp01 = (v: number): number => Math.min(1, Math.max(0, num(v)));

/** Map a 0..1 risk score to a band (higher score = worse). */
export function riskBand(score: number): RiskBand {
  const s = clamp01(score);
  if (s < 0.34) return "low";
  if (s < 0.67) return "medium";
  return "high";
}

export interface RiskFactorRow {
  key: "content" | "reputation" | "auth" | "engagement";
  label: string;
  weight: number;
  score: number;
  contribution: number;
}

const RISK_FACTOR_LABEL: Record<RiskFactorRow["key"], string> = {
  content: "Content",
  reputation: "Reputation",
  auth: "Authentication",
  engagement: "Engagement",
};

/**
 * Expand a RiskBreakdown into per-factor rows. `contribution = weight × score`
 * — the amount each factor adds to the combined risk, so the forecast is
 * explainable instead of a single opaque number.
 */
export function riskFactorRows(risk: RiskBreakdown): RiskFactorRow[] {
  const keys: RiskFactorRow["key"][] = [
    "content",
    "reputation",
    "auth",
    "engagement",
  ];
  return keys.map((key) => {
    const weight = num(risk?.weights?.[key]);
    const score = num(risk?.[key]);
    return {
      key,
      label: RISK_FACTOR_LABEL[key],
      weight,
      score,
      contribution: weight * score,
    };
  });
}

// -- Provider coverage --------------------------------------------------------

/** A provider is "measured" only when at least one seed mailbox was tested. */
export function isProviderMeasured(
  breakdown: Pick<ProviderBreakdown, "total">,
): boolean {
  return num(breakdown?.total) > 0;
}

// -- Blocklist-hit parsing ----------------------------------------------------

const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;

// Delisting / removal portals for the major DNSBL operators. Keyed by a
// case-insensitive substring of the zone name.
const DELISTING_PORTALS: ReadonlyArray<{ match: string; url: string }> = [
  { match: "spamhaus", url: "https://check.spamhaus.org/" },
  {
    match: "barracuda",
    url: "https://www.barracudacentral.org/rbl/removal-request",
  },
  { match: "spamcop", url: "https://www.spamcop.net/bl.shtml" },
  { match: "sorbs", url: "http://www.sorbs.net/lookup.shtml" },
  { match: "uceprotect", url: "https://www.uceprotect.net/en/rblcheck.php" },
  { match: "invaluement", url: "https://www.invaluement.com/lookup/" },
];

export interface ParsedBlocklistHit {
  raw: string;
  zone: string;
  containsIp: boolean;
  delistingUrl: string | null;
}

/**
 * Parse a raw blocklist-hit string into structured detail: the zone label,
 * whether an IP appears in the listing, and a delisting/removal link when the
 * operator is recognized.
 */
export function parseBlocklistHit(hit: string): ParsedBlocklistHit {
  const raw = typeof hit === "string" ? hit : String(hit ?? "");
  const zone = raw.trim();
  const lower = zone.toLowerCase();
  const portal = DELISTING_PORTALS.find((p) => lower.includes(p.match));
  return {
    raw,
    zone,
    containsIp: IPV4_RE.test(zone),
    delistingUrl: portal ? portal.url : null,
  };
}

// -- Reputation-source labels -------------------------------------------------

export const REPUTATION_SOURCE_LABEL: Record<string, string> = {
  google: "Google Postmaster",
  google_postmaster: "Google Postmaster",
  postmaster: "Google Postmaster",
  microsoft: "Microsoft SNDS",
  microsoft_snds: "Microsoft SNDS",
  snds: "Microsoft SNDS",
  senderscore: "SenderScore",
  sender_score: "SenderScore",
  blocklists: "Blocklists",
  blacklist: "Blocklists",
  blacklists: "Blocklists",
};

/** Humanize a reputation-source key (falls back to sentence-casing). */
export function reputationSourceLabel(key: string): string {
  const k = (key ?? "").toString().trim();
  if (!k) return "Unknown source";
  const known = REPUTATION_SOURCE_LABEL[k.toLowerCase()];
  if (known) return known;
  const spaced = k.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// -- Placement-fold disclosure + protocol education --------------------------

/** Which raw placements fold into each of the three headline buckets. */
export const PLACEMENT_FOLD: {
  primary: Placement[];
  promotions: Placement[];
  spam: Placement[];
} = {
  primary: ["primary", "updates", "social"],
  promotions: ["promotions"],
  spam: ["spam", "blocked", "missing"],
};

export interface ProtocolInfo {
  title: string;
  what: string;
  why: string;
  learnMore: string;
}

/**
 * One-line "what it is + why it matters" for each auth protocol, plus a docs
 * link — so non-expert senders can act on the diagnosis (INBOX-024).
 */
export const AUTH_PROTOCOL_INFO: Record<
  "SPF" | "DKIM" | "DMARC" | "BIMI" | "PTR",
  ProtocolInfo
> = {
  SPF: {
    title: "Sender Policy Framework",
    what: "Lists which mail servers are allowed to send for your domain.",
    why: "A failing or overly-broad SPF record lets others spoof you and drags placement down.",
    learnMore: "https://www.rfc-editor.org/rfc/rfc7208",
  },
  DKIM: {
    title: "DomainKeys Identified Mail",
    what: "Cryptographically signs each message so receivers can verify it wasn't altered.",
    why: "Without a valid DKIM signature, mailbox providers trust your mail far less.",
    learnMore: "https://www.rfc-editor.org/rfc/rfc6376",
  },
  DMARC: {
    title: "Domain-based Message Authentication",
    what: "Tells receivers what to do when SPF/DKIM fail, and where to send reports.",
    why: "At p=none it only monitors — no enforcement — so spoofed mail still lands and BIMI stays locked.",
    learnMore: "https://www.rfc-editor.org/rfc/rfc7489",
  },
  BIMI: {
    title: "Brand Indicators for Message Identification",
    what: "Publishes your verified logo so it shows next to your name in the inbox.",
    why: "Requires DMARC enforcement; a published logo raises trust and open rates.",
    learnMore: "https://bimigroup.org/",
  },
  PTR: {
    title: "Reverse DNS (PTR)",
    what: "Maps your sending IP back to a hostname.",
    why: "A missing or generic PTR record is treated as a strong spam signal by most receivers.",
    learnMore: "https://www.rfc-editor.org/rfc/rfc1912",
  },
};
