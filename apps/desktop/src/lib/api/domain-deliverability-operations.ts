import type { ApiResult } from "./result";
import { heldCustomDomainResult } from "../custom-domain-operational-availability";

export interface DomainDeliverabilityRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export type DomainDeliverabilityRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: DomainDeliverabilityRequestOptions,
) => Promise<ApiResult<T>>;

export interface DomainDeliverabilityOperationsDependencies {
  request: DomainDeliverabilityRequester;
}

/** Exact values enforced by the custom_domains database constraint. */
export type CustomDomainPurpose = "tracking" | "forms" | "links" | "web";

export type CustomDomainRegistrationPurpose = CustomDomainPurpose;

/**
 * One DNS record the operator must publish for a domain to verify.
 * Mirrors `custom_domains.DNSRecord`. Create/list rows may only have
 * the requested DNS values; verify responses include per-record
 * `verified`/`error` details for operator troubleshooting.
 */
export interface DNSRecord {
  type: string; // "CNAME" | "TXT" | "MX" | …
  name: string;
  value: string;
  /** Forward-compat: per-record verification result. */
  verified?: boolean;
  /** Forward-compat: per-record error message when verification failed. */
  error?: string;
}

/**
 * Mirrors `custom_domains.Domain` (Go camelCase JSON tags). The list
 * endpoint and the create response share the same shape. `dnsRecords`
 * is the JSON tag the Go side uses (`dns_records`) — TypeScript readers
 * must use snake_case.
 */
export interface CustomDomain {
  id: string;
  tenantId?: string;
  domain: string;
  purpose: CustomDomainPurpose | string;
  verified: boolean;
  /** Snake-case to match the Go JSON tag `dns_records`. */
  dns_records: DNSRecord[];
  createdAt?: string;
  verifiedAt?: string | null;
}

/**
 * Response from the `verify` POST. Current API returns the overall
 * boolean and per-record DNS lookup results.
 */
export interface DomainVerifyResponse {
  verified: boolean;
  records?: DNSRecord[];
}
/* ---------- DNS health -------------------------------------------- */

export interface DnsHealthStatus {
  id: string;
  domain: string;
  verify_state: string;
  spf_verified_at?: string | null;
  dkim_verified_at?: string | null;
  dmarc_verified_at?: string | null;
  last_attempt_at?: string | null;
  last_error?: string;
  is_stale: boolean;
  hours_since_last_check: number;
}

export interface DnsHealthResponse {
  identities: DnsHealthStatus[];
}

/* ---------- Sender reputation ------------------------------------- */

export interface SenderReputationDomain {
  domain: string;
  score: number;
  grade: string;
  sends_last_7d: number;
  bounce_rate: number;
  complaint_rate: number;
  dmarc_pass_rate: number;
  blocklist_hits: number;
  last_incident_at?: string | null;
}

export interface SenderReputationResponse {
  domains: SenderReputationDomain[];
}

export interface SenderReputationHistoryPoint {
  day: string;
  score: number;
  sends: number;
  bounce_rate: number;
  complaint_rate: number;
}

export interface SenderReputationHistoryResponse {
  domain: string;
  days: SenderReputationHistoryPoint[];
}

/** Tenant-minimized projection of one ingested aggregate report. */
export interface DmarcReport {
  /** Aggregate-report UUID. */
  id: string;
  orgName: string;
  reportId: string;
  domain: string;
  policyP: "" | "none" | "quarantine" | "reject" | "unknown";
  policyPct: number | null;
  dateBegin: string;
  dateEnd: string;
  passCount: number;
  failCount: number;
  receivedAt: string;
}

export interface DmarcReportsMeta {
  generatedAt: string;
  limit: number;
  returned: number;
  totalReports: number;
  hasMore: boolean;
  availableDomains: string[];
  domainInventoryTruncated: boolean;
  scope: {
    domain?: string;
    from?: string;
    to?: string;
  };
}

/** Canonical bounded envelope returned by the first-party DMARC route. */
export interface DmarcReportsResponse {
  items: DmarcReport[];
  meta: DmarcReportsMeta;
}

/* ----- Refined DMARC PR 1: insights types (mirror dmarc/insights.go) ----- */

/** Mirrors `dmarc.AlignmentSummary`. AlignedPct is 0-1. */
export interface DmarcAlignment {
  bothPass: number;
  dkimOnlyPass: number;
  spfOnlyPass: number;
  neitherPass: number;
  alignedPct: number;
}

/** Mirrors `dmarc.DispositionSummary`. Counts are message counts. */
export interface DmarcDisposition {
  none: number;
  quarantine: number;
  reject: number;
  unknown: number;
}

/** Mirrors `dmarc.SourceRow`. One sending IP's slice of the totals. */
export interface DmarcSource {
  sourceIp: string;
  messages: number;
  dkimPass: number;
  spfPass: number;
  bothPass: number;
  alignedPct: number;
  primaryDisposition: "none" | "quarantine" | "reject" | "unknown";
  quarantined: number;
  rejected: number;
  /** Canonical hostname only; local-parts and full mailbox values are omitted. */
  envelopeFromDomain?: string;
}

/**
 * Evidence-backed read-only guidance returned by the aggregate-report model.
 * It never contains a copyable DNS record: an observed report is not an
 * authoritative view of the domain's current DNS policy.
 */
export interface DmarcSuggestion {
  code: string;
  severity: "info" | "warning" | "action";
  action: string;
  reason?: string;
}

/** Refined DMARC PR 2: per-day alignment slice for the sparkline. */
export interface DmarcDailyPoint {
  date: string;
  messages: number;
  aligned: number;
  alignedPct: number;
}

/** Mirrors `dmarc.InsightsResponse`. Wire shape for `getDmarcInsights`. */
export interface DmarcInsights {
  domain: string;
  periodDays: number;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  latestReportAt?: string;
  reportingDays: number;
  reportCount: number;
  totalMessages: number;
  sourceCount: number;
  sourceListTruncated: boolean;
  alignment: DmarcAlignment;
  disposition: DmarcDisposition;
  topSources: DmarcSource[];
  topFailingSources: DmarcSource[];
  suggestions: DmarcSuggestion[];
  /** Non-empty reporting days in ascending UTC date order. */
  series: DmarcDailyPoint[];
  /**
   * Most-recent policy value observed inside a report for an explicitly
   * selected domain. This is evidence, not a live DNS lookup.
   */
  latestPolicy?: "none" | "quarantine" | "reject" | "unknown";
}

/** Refined DMARC PR 2: one report's contribution to a source IP. */
export interface DmarcSourcePerReport {
  reportId: string;
  orgName: string;
  dateBegin: string;
  dateEnd: string;
  messages: number;
  dkimPass: number;
  spfPass: number;
  bothPass: number;
  alignedPct: number;
  primaryDisposition: "none" | "quarantine" | "reject" | "unknown";
}

/** Refined DMARC PR 2: response shape for `getDmarcSourceDetail`. */
export interface DmarcSourceDetail {
  sourceIp: string;
  periodDays: number;
  domain?: string;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  hasMore: boolean;
  summary: DmarcSource;
  perReport: DmarcSourcePerReport[];
}

/** GET /api/v1/custom-domains — list domains for the tenant. */
export function createListCustomDomains({
  request,
}: DomainDeliverabilityOperationsDependencies) {
  return function listCustomDomains(): Promise<ApiResult<CustomDomain[]>> {
    return request<CustomDomain[]>("/api/v1/custom-domains", {
      cache: "no-store",
    });
  };
}

/**
 * Registration compatibility method. The supported desktop client rejects it
 * locally while the synchronized custom-domain release hold is active.
 */
export function createCreateCustomDomain({
  request: _request,
}: DomainDeliverabilityOperationsDependencies) {
  return function createCustomDomain(input: {
    domain: string;
    purpose: CustomDomainRegistrationPurpose;
  }): Promise<ApiResult<CustomDomain>> {
    void input;
    return Promise.resolve(heldCustomDomainResult("registration"));
  };
}

/** GET /api/v1/custom-domains/{id} — current tenant-owned registry row. */
export function createGetCustomDomain({
  request,
}: DomainDeliverabilityOperationsDependencies) {
  return function getCustomDomain(
    id: string,
  ): Promise<ApiResult<CustomDomain>> {
    return request<CustomDomain>(
      `/api/v1/custom-domains/${encodeURIComponent(id)}`,
      { cache: "no-store" },
    );
  };
}

/**
 * Verification compatibility method. No DNS request is sent while the
 * synchronized release hold is active.
 */
export function createVerifyCustomDomain({
  request: _request,
}: DomainDeliverabilityOperationsDependencies) {
  return function verifyCustomDomain(
    id: string,
  ): Promise<ApiResult<DomainVerifyResponse>> {
    void id;
    return Promise.resolve(heldCustomDomainResult("verification"));
  };
}

/** Removal compatibility method; held locally before transport. */
export function createDeleteCustomDomain({
  request: _request,
}: DomainDeliverabilityOperationsDependencies) {
  return function deleteCustomDomain(
    id: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    void id;
    return Promise.resolve(heldCustomDomainResult("removal"));
  };
}

export function createListDnsHealth({
  request,
}: DomainDeliverabilityOperationsDependencies) {
  return function listDnsHealth(): Promise<ApiResult<DnsHealthResponse>> {
    return request<DnsHealthResponse>("/api/v1/dns-health");
  };
}

export function createListDnsHealthIssues({
  request,
}: DomainDeliverabilityOperationsDependencies) {
  return function listDnsHealthIssues(): Promise<ApiResult<DnsHealthResponse>> {
    return request<DnsHealthResponse>("/api/v1/dns-health/issues");
  };
}

export function createRunDnsHealthNow({
  request,
}: DomainDeliverabilityOperationsDependencies) {
  return function runDnsHealthNow(): Promise<ApiResult<{ rechecked: number }>> {
    return request<{ rechecked: number }>("/api/v1/dns-health/run-now", {
      method: "POST",
      body: "{}",
    });
  };
}

export function createGetSenderReputation({
  request,
}: DomainDeliverabilityOperationsDependencies) {
  return function getSenderReputation(): Promise<
    ApiResult<SenderReputationResponse>
  > {
    return request<SenderReputationResponse>("/api/v1/sender-reputation");
  };
}

export function createGetSenderReputationHistory({
  request,
}: DomainDeliverabilityOperationsDependencies) {
  return function getSenderReputationHistory(
    domain: string,
  ): Promise<ApiResult<SenderReputationHistoryResponse>> {
    return request<SenderReputationHistoryResponse>(
      `/api/v1/sender-reputation/${encodeURIComponent(domain)}/history`,
    );
  };
}

/**
 * GET /api/v1/deliverability/dmarc-reports — bounded aggregate reports with
 * an explicit scope and completeness receipt.
 */
export function createListDmarcReports({
  request,
}: DomainDeliverabilityOperationsDependencies) {
  return function listDmarcReports(
    opts: {
      domain?: string;
      from?: string;
      to?: string;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ApiResult<DmarcReportsResponse>> {
    const params = new URLSearchParams();
    if (opts.domain) params.set("domain", opts.domain);
    if (opts.from) params.set("from", opts.from);
    if (opts.to) params.set("to", opts.to);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request<DmarcReportsResponse>(
      `/api/v1/deliverability/dmarc-reports${qs ? `?${qs}` : ""}`,
      { cache: "no-store" },
      opts.signal ? { signal: opts.signal } : undefined,
    );
  };
}

/**
 * Refined DMARC PR 1: GET /api/v1/deliverability/dmarc-insights.
 *
 * Returns the actionable rollup (alignment summary, disposition
 * breakdown, top sources, top failing sources, and a hand-tuned
 * list of suggestions) for one (domain, period) slice. The Go side
 * is read-only; we surface it on the DMARC reports page so the
 * operator sees what to fix without scrolling raw reports.
 *
 * `days` is validated server-side in [1, 365], default 30.
 * `domain` empty = tenant-wide.
 */
export function createGetDmarcInsights({
  request,
}: DomainDeliverabilityOperationsDependencies) {
  return function getDmarcInsights(
    opts: { domain?: string; days?: number; signal?: AbortSignal } = {},
  ): Promise<ApiResult<DmarcInsights>> {
    const params = new URLSearchParams();
    if (opts.domain) params.set("domain", opts.domain);
    if (opts.days) params.set("days", String(opts.days));
    const qs = params.toString();
    return request<DmarcInsights>(
      `/api/v1/deliverability/dmarc-insights${qs ? `?${qs}` : ""}`,
      { cache: "no-store" },
      opts.signal ? { signal: opts.signal } : undefined,
    );
  };
}

/**
 * Refined DMARC PR 2: GET /api/v1/deliverability/dmarc-sources?ip=&domain=&days=.
 * Per-source drill-down — given an IP, lists every report that
 * carried records for it within the period, with per-report
 * alignment %. Used by the source slideover.
 */
export function createGetDmarcSourceDetail({
  request,
}: DomainDeliverabilityOperationsDependencies) {
  return function getDmarcSourceDetail(opts: {
    ip: string;
    domain?: string;
    days?: number;
    signal?: AbortSignal;
  }): Promise<ApiResult<DmarcSourceDetail>> {
    const params = new URLSearchParams({ ip: opts.ip });
    if (opts.domain) params.set("domain", opts.domain);
    if (opts.days) params.set("days", String(opts.days));
    return request<DmarcSourceDetail>(
      `/api/v1/deliverability/dmarc-sources?${params.toString()}`,
      { cache: "no-store" },
      opts.signal ? { signal: opts.signal } : undefined,
    );
  };
}

/**
 * Reserved acknowledgement transport. Production composition keeps this
 * mutation unavailable until acknowledgement scope, actor evidence, expiry,
 * and reopening semantics are durable. The DMARC UI does not expose it.
 */
export function createAckDmarcSuggestion({
  request,
}: DomainDeliverabilityOperationsDependencies) {
  return function ackDmarcSuggestion(
    code: string,
    note?: string,
  ): Promise<ApiResult<{ ok: boolean; code: string }>> {
    return request<{ ok: boolean; code: string }>(
      "/api/v1/deliverability/dmarc-suggestions/ack",
      {
        method: "POST",
        body: JSON.stringify({ code, note: note ?? "" }),
      },
    );
  };
}

/**
 * Refined DMARC PR 2: DELETE
 * /api/v1/deliverability/dmarc-suggestions/ack/{code}.
 * Brings a dismissed suggestion back. Hard delete — idempotent.
 */
export function createUnackDmarcSuggestion({
  request,
}: DomainDeliverabilityOperationsDependencies) {
  return function unackDmarcSuggestion(
    code: string,
  ): Promise<ApiResult<{ ok: boolean; code: string }>> {
    return request<{ ok: boolean; code: string }>(
      `/api/v1/deliverability/dmarc-suggestions/ack/${encodeURIComponent(code)}`,
      { method: "DELETE" },
    );
  };
}

export function createDomainDeliverabilityOperationsMethods(
  dependencies: DomainDeliverabilityOperationsDependencies,
) {
  return {
    listCustomDomains: createListCustomDomains(dependencies),
    createCustomDomain: createCreateCustomDomain(dependencies),
    getCustomDomain: createGetCustomDomain(dependencies),
    verifyCustomDomain: createVerifyCustomDomain(dependencies),
    deleteCustomDomain: createDeleteCustomDomain(dependencies),
    listDnsHealth: createListDnsHealth(dependencies),
    listDnsHealthIssues: createListDnsHealthIssues(dependencies),
    runDnsHealthNow: createRunDnsHealthNow(dependencies),
    getSenderReputation: createGetSenderReputation(dependencies),
    getSenderReputationHistory: createGetSenderReputationHistory(dependencies),
    listDmarcReports: createListDmarcReports(dependencies),
    getDmarcInsights: createGetDmarcInsights(dependencies),
    getDmarcSourceDetail: createGetDmarcSourceDetail(dependencies),
    ackDmarcSuggestion: createAckDmarcSuggestion(dependencies),
    unackDmarcSuggestion: createUnackDmarcSuggestion(dependencies),
  };
}
