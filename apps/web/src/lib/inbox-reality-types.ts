// SPDX-License-Identifier: AGPL-3.0-only
//
// KEEP IN SYNC WITH:
//   services/deliverability/internal/domain/types.go
//
// Any change to the Go domain types (Placement enum, AuthRecord,
// Reputation, Diagnosis, Fix, etc.) must be mirrored here. The wire
// shape is the contract — fields use snake_case to match the JSON.

export type Placement =
  | "primary"
  | "promotions"
  | "updates"
  | "social"
  | "spam"
  | "blocked"
  | "missing";

export type Provider =
  | "gmail"
  | "outlook_com"
  | "o365"
  | "icloud"
  | "yahoo"
  | "proton"
  | "gmx"
  | "mailru";

export interface InboxReport {
  campaign_id: string;
  provider: Provider;
  mailbox_id: string;
  placement: Placement;
  checked_at: string;
}

export interface ProviderBreakdown {
  provider: Provider;
  total: number;
  placements: Partial<Record<Placement, number>>;
}

export interface CampaignReport {
  campaign_id: string;
  campaign_name?: string;
  sent_at?: string;
  providers: ProviderBreakdown[];
  overall_pct: Partial<Record<Placement, number>>;
  total_inboxes: number;
  generated_at: string;
  diagnostic_id?: string;
  reports?: InboxReport[];
}

export type ReputationScore = "low" | "medium" | "high";

export interface Reputation {
  domain: string;
  ip: string;
	google_score: ReputationScore | null;
	microsoft_score: ReputationScore | null;
	sender_score: number | null;
  blacklist_hits: string[];
  checked_at: string;
	data_available: boolean;
	sources_succeeded?: string[];
	sources_failed?: string[];
}

// Reputation trend (INBOX-031).
//
// KEEP IN SYNC WITH:
//   services/deliverability/internal/reputation/snapshot_store.go
//     (ReputationSnapshot)
// One point per reputation fetch. sender_score is -1 when the source was
// unavailable at capture time; google/microsoft use "low|medium|high|''".
export interface ReputationSnapshot {
  sender_score: number;
  google_score: string;
  microsoft_score: string;
  blacklist_hit_count: number;
  data_available: boolean;
  checked_at: string;
}

// DMARC aggregate-report monitoring (INBOX-032).
//
// KEEP IN SYNC WITH:
//   services/deliverability/internal/auth/dmarc_storage.go
//     (PersistedReport, PersistedRecord, ReportDetail, Stats)
// snake_case matches the JSON wire shape; Go time.Time -> string, int -> number.

export interface PersistedReport {
  id: string;
  tenant_id: string;
  org_name: string;
  report_id: string;
  date_range_begin: string;
  date_range_end: string;
  domain: string;
  policy_p: string;
  policy_sp: string;
  policy_pct: number;
  ingested_at: string;
  source_message_id: string;
}

export interface PersistedRecord {
  id: string;
  report_id: string;
  source_ip: string;
  count: number;
  disposition: string;
  dkim_result: string;
  spf_result: string;
  header_from: string;
  envelope_from: string;
  envelope_to: string;
}

export interface ReportDetail {
  report: PersistedReport;
  records: PersistedRecord[];
}

// Named DmarcStats (Go type is `Stats`) to avoid a bare `Stats` export.
export interface DmarcStats {
  total_reports: number;
  total_records: number;
  total_count: number;
  dkim_pass: number;
  dkim_fail: number;
  spf_pass: number;
  spf_fail: number;
  pass_count: number;
  fail_count: number;
}

export type AuthStatus = "ok" | "warn" | "fail";

export interface AuthRecord {
  status: AuthStatus;
  detail: string;
}

export interface AuthCheck {
  domain: string;
  spf: AuthRecord;
  dkim: AuthRecord;
  dmarc: AuthRecord;
  bimi: AuthRecord;
  ptr: AuthRecord;
}

export interface ContentScan {
  spam_score: number;
  spam_reasons?: string[];
  image_text_ratio: number;
  link_reputation: AuthStatus;
  html_issues?: string[];
  model?: ModelDisclosure;
}

export interface ModelDisclosure {
  name: string;
  version: string;
  kind: string;
  source: string;
  trained: boolean;
  notes?: string[];
}

export interface RiskBreakdown {
  model: ModelDisclosure;
  weights: {
    content: number;
    reputation: number;
    auth: number;
    engagement: number;
  };
  content: number;
  reputation: number;
  auth: number;
  engagement: number;
  combined: number;
  assumptions?: string[];
}

export type FixAction =
  | "dns_record"
  | "copy_change"
  | "image_swap"
  | "resend";

export interface DNSRecord {
  type: string;
  name: string;
  value: string;
  ttl?: number;
}

export interface Fix {
  title: string;
  detail: string;
  action: FixAction;
  dns_record?: DNSRecord;
  estimated_impact: number;
}

export interface Diagnosis {
  campaign_id: string;
  diagnosis: string;
  fixes: Fix[];
  predicted_impact: Record<string, number>;
  generated_at: string;
}

export interface PredictedPlacement {
  primary: number;
  promotions: number;
  spam: number;
}

export interface PredictResponse {
  predicted: PredictedPlacement;
  content: ContentScan;
  risk: RiskBreakdown;
  at: string;
}

// UI-friendly helpers --------------------------------------------------

export const PROVIDER_LABEL: Record<Provider, string> = {
  gmail: "Gmail",
  outlook_com: "Outlook.com",
  o365: "Microsoft 365",
  icloud: "iCloud",
  yahoo: "Yahoo",
  proton: "ProtonMail",
  gmx: "GMX",
  mailru: "Mail.ru",
};

export const ALL_PROVIDERS: Provider[] = [
  "gmail",
  "outlook_com",
  "o365",
  "icloud",
  "yahoo",
  "proton",
  "gmx",
  "mailru",
];

export interface PlacementSummary {
  primary: number;
  promotions: number;
  spam: number;
}

/**
 * Reduce a ProviderBreakdown's placements map to {primary, promotions,
 * spam} percentages. updates/social fold into primary; blocked/missing
 * fold into spam.
 */
export function summarizePlacement(
  pb: ProviderBreakdown,
): PlacementSummary {
  if (pb.total === 0) return { primary: 0, promotions: 0, spam: 0 };
  const p = pb.placements;
  const primary =
    (p.primary ?? 0) + (p.updates ?? 0) + (p.social ?? 0);
  const promotions = p.promotions ?? 0;
  const spam = (p.spam ?? 0) + (p.blocked ?? 0) + (p.missing ?? 0);
  return {
    primary: primary / pb.total,
    promotions: promotions / pb.total,
    spam: spam / pb.total,
  };
}
