// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "sending"
  | "sent"
  | "paused"
  | "cancelled";

export interface Campaign {
  id: string;
  tenant_id: string;
  name: string;
  subject: string;
  status: CampaignStatus;
  body_html?: string;
  body_mjml?: string;
  segment_id?: string;
  scheduled_at?: string | null;
  sent_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListCampaignsParams {
  query?: string;
  q?: string;
  page?: number;
  per_page?: number;
  limit?: number;
}

export interface CreateCampaignInput {
  name: string;
  subject: string;
  body_html?: string;
  body_mjml?: string;
  segment_id?: string;
  scheduled_at?: string | null;
}

export type UpdateCampaignInput = Partial<CreateCampaignInput> & {
  status?: CampaignStatus;
};

export type SendTestEmailInput =
  | {
      /** Existing campaign draft id. When set, subject/body default from the draft. */
      campaignId: string;
      /** Recipient email address. */
      toEmail: string;
      /** Optional override subject line. */
      subject?: string;
      /** Optional override pre-rendered HTML body. */
      bodyHtml?: string;
      /** Optional override MJML body; the API renders it for test sends. */
      bodyMjml?: string;
      /** Optional override plain-text body; the API wraps it for test sends. */
      plainText?: string;
    }
  | {
      campaignId?: undefined;
      /** Recipient email address. */
      toEmail: string;
      /** Subject line. */
      subject: string;
      /** Pre-rendered HTML body. Pass one of bodyHtml/bodyMjml/plainText. */
      bodyHtml?: string;
      /** MJML body; the API renders it for test sends. */
      bodyMjml?: string;
      /** Plain-text body; the API wraps it for test sends. */
      plainText?: string;
    };

export interface SendTestEmailResponse {
  /** The provider message id (e.g. Postmark MessageID). */
  message_id: string;
  /** The recipient that was sent to. */
  to: string;
  /** ISO-8601 timestamp the message was accepted by the provider. */
  accepted_at: string;
}

export interface CampaignQueueResponse {
  campaign_id: string;
  content_revision_id?: string;
  assurance_run_id?: string;
  send_plan_id?: string;
  assurance_decision?: "pass" | "warn" | "overridden";
  /** `warn` is an unbound advisory; only `block` carries send authority. */
  assurance_rollout_mode?: "warn" | "block";
  assurance_status?:
    | "ok"
    | "warn"
    | "critical"
    | "pending"
    | "stale"
    | "unavailable"
    | "error";
  assurance_reason_code?:
    | "authorized"
    | "authorized_warn"
    | "authorized_override"
    | "not_assured"
    | "run_pending"
    | "run_stale"
    | "evidence_unavailable"
    | "deterministic_block"
    | "integrity_mismatch"
    | "dependency_error";
  recipients_queued: number;
  status: CampaignStatus | "approval_required";
  approval_id?: string;
  approval_status?: string;
  message?: string;
  sandbox?: boolean;
}

export interface CampaignSendOptions {
  /** Force sandbox lifecycle simulation. No live ESP/Listmonk send occurs. */
  sandbox?: boolean;
}

/** Campaign-wide non-monetary counts. Amounts remain item-level and currency-scoped. */
export interface CampaignDirectAttributionEvidenceSummary {
  code_allocations: number;
  code_redemptions: number;
  code_linked_outcomes: number;
  no_click_redemptions: number;
  with_click_redemptions: number;
  click_evidence_unavailable: number;
  vanity_visits: number;
  vanity_linked_outcomes: number;
}

/** One allocation receipt or shared vanity-path visit. Never recipient identity. */
export interface CampaignDirectAttributionEvidenceItem {
  kind: "code_allocation" | "vanity_visit";
  evidence_id: string;
  occurred_at: string;
  status: string;
  expires_at: string | null;
  redeemed_at: string | null;
  redemption_id: number | null;
  conversion_id: number | null;
  amount_cents: number | null;
  currency: string;
  attributed_via: "code_redemption" | "campaign_vanity_path";
  attribution_scope: "campaign_assignment" | "campaign";
  /** Null means the historical event-time observation was unavailable. */
  linked_without_recorded_assignment_click: boolean | null;
  /** Campaign linkage cannot prove that a person read a message. */
  readership_proven: false;
}

export interface CampaignDirectAttributionEvidencePageInfo {
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
}

export interface CampaignDirectAttributionEvidencePage {
  campaign_id: string;
  summary: CampaignDirectAttributionEvidenceSummary;
  items: CampaignDirectAttributionEvidenceItem[];
  page_info: CampaignDirectAttributionEvidencePageInfo;
}

export interface CampaignDirectAttributionEvidenceListOptions {
  /** Defaults to 25 and must be from 1 through 100. */
  limit?: number;
  /** Defaults to 0 and must be from 0 through 10,000. */
  offset?: number;
}

/**
 * Campaigns resource. The `sendTest` helper sends a single one-off
 * transactional message via the tenant's sending pipeline — useful for
 * previewing a draft before promoting it to a campaign.
 *
 * `queue` uses Moosewave's production lifecycle: compliance checks, approval
 * gating, suppression filtering, and sandbox simulation when requested.
 * `send` is the immediate Listmonk handoff path and can also return an
 * approval-required response when the campaign has not yet been approved.
 */
export class CampaignsResource extends Resource {
  list(params: ListCampaignsParams = {}): Promise<Campaign[]> {
    return this.client.request("GET", "/api/v1/campaigns", {
      query: params as Record<string, string | number | undefined>,
    });
  }

  get(id: string): Promise<Campaign> {
    return this.client.request(
      "GET",
      `/api/v1/campaigns/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Read one bounded page of audited code-allocation and shared vanity-path
   * evidence. This method performs exactly one read; callers explicitly choose
   * whether and when to request the next offset.
   */
  async listDirectAttributionEvidence(
    id: string,
    options: CampaignDirectAttributionEvidenceListOptions = {},
  ): Promise<CampaignDirectAttributionEvidencePage> {
    const campaign = campaignEvidenceSegment(id);
    const query = campaignEvidenceListQuery(options);
    const value = await this.client.request<unknown>(
      "GET",
      `/api/v1/campaigns/${campaign}/direct-attribution-evidence`,
      { query },
    );
    return decodeCampaignDirectAttributionEvidencePage(value);
  }

  create(input: CreateCampaignInput): Promise<Campaign> {
    return this.client.request("POST", "/api/v1/campaigns", { body: input });
  }

  update(id: string, patch: UpdateCampaignInput): Promise<Campaign> {
    return this.client.request(
      "PATCH",
      `/api/v1/campaigns/${encodeURIComponent(id)}`,
      { body: patch },
    );
  }

  delete(id: string): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/campaigns/${encodeURIComponent(id)}`,
    );
  }

  queue(
    id: string,
    opts: CampaignSendOptions = {},
  ): Promise<CampaignQueueResponse> {
    return this.client.request(
      "POST",
      `/api/v1/campaigns/${encodeURIComponent(id)}/queue`,
      {
        headers: sandboxHeaders(opts),
      },
    );
  }

  send(
    id: string,
    opts: CampaignSendOptions = {},
  ): Promise<Campaign | CampaignQueueResponse> {
    return this.client.request(
      "POST",
      `/api/v1/campaigns/${encodeURIComponent(id)}/send`,
      {
        headers: sandboxHeaders(opts),
      },
    );
  }

  /**
   * Set, move, or clear a campaign's send time.
   *
   * `PATCH /api/v1/campaigns/{id}` refuses any body carrying `scheduled_at` —
   * including an explicit `null`, because the guard tests for the field's
   * presence rather than its value — with 422 `campaign_dispatch_state_owned`.
   * The send time belongs to this lifecycle route.
   *
   * Pass `null` to unschedule; the campaign returns to `draft`. Only a `draft`
   * or `scheduled` campaign can carry a send time: the scheduler claims
   * `scheduled` rows and nothing else, so a time written onto a cancelled or
   * dispatched campaign would never fire (409).
   *
   * Returns 503 `campaign_scheduling_unqualified` while durable dispatch
   * recovery is not release-qualified.
   */
  schedule(id: string, scheduledAt: string | null): Promise<Campaign> {
    return this.client.request(
      "POST",
      `/api/v1/campaigns/${encodeURIComponent(id)}/schedule`,
      { body: { scheduled_at: scheduledAt } },
    );
  }

  /**
   * Pause a campaign that is currently `sending` or `scheduled`.
   * Returns the updated campaign. The server rejects (409) campaigns
   * that are not in a pausable state.
   */
  pause(id: string): Promise<Campaign> {
    return this.client.request(
      "POST",
      `/api/v1/campaigns/${encodeURIComponent(id)}/pause`,
    );
  }

  /**
   * Resume a `paused` campaign, returning it to `sending`. Returns 423
   * (Locked) when the tenant's email kill switch is engaged.
   */
  resume(id: string): Promise<Campaign> {
    return this.client.request(
      "POST",
      `/api/v1/campaigns/${encodeURIComponent(id)}/resume`,
    );
  }

  /**
   * Cancel a campaign that is `draft`, `scheduled`, `sending`, or
   * `paused`, transitioning it to `cancelled`. Returns the updated campaign.
   */
  cancel(id: string): Promise<Campaign> {
    return this.client.request(
      "POST",
      `/api/v1/campaigns/${encodeURIComponent(id)}/cancel`,
    );
  }

  sendTest(input: SendTestEmailInput): Promise<SendTestEmailResponse> {
    if (
      !input.campaignId &&
      !input.bodyHtml &&
      !input.bodyMjml &&
      !input.plainText
    ) {
      throw new Error(
        "sendTest: pass campaignId, bodyHtml, bodyMjml, or plainText",
      );
    }
    const path = input.campaignId
      ? `/api/v1/campaigns/${encodeURIComponent(input.campaignId)}/test-send`
      : "/api/v1/campaigns/test-send";
    return this.client.request("POST", path, {
      body: {
        to_email: input.toEmail,
        subject: input.subject,
        body_html: input.bodyHtml,
        body_mjml: input.bodyMjml,
        plain_text: input.plainText,
      },
    });
  }
}

function sandboxHeaders(
  opts: CampaignSendOptions,
): Record<string, string> | undefined {
  return opts.sandbox ? { "X-Postwave-Sandbox": "true" } : undefined;
}

const CAMPAIGN_EVIDENCE_SUMMARY_FIELDS = [
  "code_allocations",
  "code_redemptions",
  "code_linked_outcomes",
  "no_click_redemptions",
  "with_click_redemptions",
  "click_evidence_unavailable",
  "vanity_visits",
  "vanity_linked_outcomes",
] as const satisfies readonly (keyof CampaignDirectAttributionEvidenceSummary)[];

const CAMPAIGN_EVIDENCE_ITEM_FIELDS = [
  "kind",
  "evidence_id",
  "occurred_at",
  "status",
  "expires_at",
  "redeemed_at",
  "redemption_id",
  "conversion_id",
  "amount_cents",
  "currency",
  "attributed_via",
  "attribution_scope",
  "linked_without_recorded_assignment_click",
  "readership_proven",
] as const;

function campaignEvidenceSegment(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(
      "campaign direct-attribution evidence campaign ID is required",
    );
  }
  return encodeURIComponent(value);
}

function campaignEvidenceListQuery(
  options: CampaignDirectAttributionEvidenceListOptions,
): Record<string, number> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError(
      "campaign direct-attribution evidence list options must be an object",
    );
  }
  const unknown = Object.keys(options).filter(
    (key) => key !== "limit" && key !== "offset",
  );
  if (unknown.length > 0) {
    throw new TypeError(
      "campaign direct-attribution evidence list options contain an unknown field",
    );
  }
  const limit = options.limit ?? 25;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError(
      "campaign direct-attribution evidence limit must be an integer from 1 to 100",
    );
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) {
    throw new TypeError(
      "campaign direct-attribution evidence offset must be an integer from 0 to 10000",
    );
  }
  return { limit, offset };
}

function evidenceRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      `invalid campaign direct-attribution evidence ${label}`,
    );
  }
  return value as Record<string, unknown>;
}

function evidenceExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== fields.length ||
    fields.some((field) => !Object.prototype.hasOwnProperty.call(value, field))
  ) {
    throw new TypeError(
      `invalid campaign direct-attribution evidence ${label} fields`,
    );
  }
}

function evidenceInteger(
  value: unknown,
  label: string,
  minimum?: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (minimum !== undefined && value < minimum)
  ) {
    throw new TypeError(
      `invalid campaign direct-attribution evidence ${label}`,
    );
  }
  return value;
}

function evidenceString(
  value: unknown,
  label: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new TypeError(
      `invalid campaign direct-attribution evidence ${label}`,
    );
  }
  return value;
}

function evidenceUUID(value: unknown, label: string): string {
  const result = evidenceString(value, label);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      result,
    )
  ) {
    throw new TypeError(
      `invalid campaign direct-attribution evidence ${label}`,
    );
  }
  return result;
}

function evidenceTimestamp(value: unknown, label: string): string {
  const result = evidenceString(value, label);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(
      result,
    );
  if (!match) {
    throw new TypeError(
      `invalid campaign direct-attribution evidence ${label}`,
    );
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    offsetHourText = "0",
    offsetMinuteText = "0",
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText);
  const offsetMinute = Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new TypeError(
      `invalid campaign direct-attribution evidence ${label}`,
    );
  }
  return result;
}

function nullableEvidenceTimestamp(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : evidenceTimestamp(value, label);
}

function nullableEvidenceInteger(
  value: unknown,
  label: string,
  minimum?: number,
): number | null {
  return value === null ? null : evidenceInteger(value, label, minimum);
}

/** Strict identity-minimizing decoder for the public SDK result. */
export function decodeCampaignDirectAttributionEvidencePage(
  value: unknown,
): CampaignDirectAttributionEvidencePage {
  const root = evidenceRecord(value, "page");
  evidenceExactFields(
    root,
    ["campaign_id", "summary", "items", "page_info"],
    "page",
  );

  const summaryRaw = evidenceRecord(root.summary, "summary");
  evidenceExactFields(summaryRaw, CAMPAIGN_EVIDENCE_SUMMARY_FIELDS, "summary");
  const summary = {} as CampaignDirectAttributionEvidenceSummary;
  for (const field of CAMPAIGN_EVIDENCE_SUMMARY_FIELDS) {
    summary[field] = evidenceInteger(summaryRaw[field], `summary.${field}`, 0);
  }
  const observedClickRedemptions =
    summary.no_click_redemptions +
    summary.with_click_redemptions +
    summary.click_evidence_unavailable;
  if (
    !Number.isSafeInteger(observedClickRedemptions) ||
    summary.code_redemptions > summary.code_allocations ||
    summary.code_linked_outcomes > summary.code_allocations ||
    observedClickRedemptions !== summary.code_redemptions ||
    summary.vanity_linked_outcomes > summary.vanity_visits
  ) {
    throw new TypeError(
      "inconsistent campaign direct-attribution evidence summary",
    );
  }

  if (!Array.isArray(root.items) || root.items.length > 100) {
    throw new TypeError("invalid campaign direct-attribution evidence items");
  }
  const items = root.items.map(
    (candidate, index): CampaignDirectAttributionEvidenceItem => {
      const item = evidenceRecord(candidate, `item ${index + 1}`);
      evidenceExactFields(
        item,
        CAMPAIGN_EVIDENCE_ITEM_FIELDS,
        `item ${index + 1}`,
      );
      const kind = evidenceString(item.kind, "item kind");
      const attributedVia = evidenceString(
        item.attributed_via,
        "item attributed_via",
      );
      const attributionScope = evidenceString(
        item.attribution_scope,
        "item attribution_scope",
      );
      if (
        (kind !== "code_allocation" && kind !== "vanity_visit") ||
        (attributedVia !== "code_redemption" &&
          attributedVia !== "campaign_vanity_path") ||
        (attributionScope !== "campaign_assignment" &&
          attributionScope !== "campaign")
      ) {
        throw new TypeError(
          "invalid campaign direct-attribution evidence provenance",
        );
      }
      if (
        (kind === "code_allocation" &&
          (attributedVia !== "code_redemption" ||
            attributionScope !== "campaign_assignment")) ||
        (kind === "vanity_visit" &&
          (attributedVia !== "campaign_vanity_path" ||
            attributionScope !== "campaign"))
      ) {
        throw new TypeError(
          "inconsistent campaign direct-attribution evidence provenance",
        );
      }
      if (item.readership_proven !== false) {
        throw new TypeError(
          "campaign direct-attribution evidence cannot prove readership",
        );
      }
      if (
        item.linked_without_recorded_assignment_click !== null &&
        typeof item.linked_without_recorded_assignment_click !== "boolean"
      ) {
        throw new TypeError(
          "invalid campaign direct-attribution evidence click observation",
        );
      }
      const amountCents = nullableEvidenceInteger(
        item.amount_cents,
        "item amount_cents",
      );
      const currency = evidenceString(item.currency, "item currency", true);
      if (currency !== "" && !/^[A-Z]{3}$/u.test(currency)) {
        throw new TypeError(
          "invalid campaign direct-attribution evidence currency provenance",
        );
      }
      return {
        kind,
        evidence_id: evidenceUUID(item.evidence_id, "item evidence_id"),
        occurred_at: evidenceTimestamp(item.occurred_at, "item occurred_at"),
        status: evidenceString(item.status, "item status"),
        expires_at: nullableEvidenceTimestamp(
          item.expires_at,
          "item expires_at",
        ),
        redeemed_at: nullableEvidenceTimestamp(
          item.redeemed_at,
          "item redeemed_at",
        ),
        redemption_id: nullableEvidenceInteger(
          item.redemption_id,
          "item redemption_id",
          1,
        ),
        conversion_id: nullableEvidenceInteger(
          item.conversion_id,
          "item conversion_id",
          1,
        ),
        amount_cents: amountCents,
        currency,
        attributed_via: attributedVia,
        attribution_scope: attributionScope,
        linked_without_recorded_assignment_click:
          item.linked_without_recorded_assignment_click,
        readership_proven: false,
      };
    },
  );

  const pageRaw = evidenceRecord(root.page_info, "page_info");
  evidenceExactFields(
    pageRaw,
    ["limit", "offset", "total", "has_more"],
    "page_info",
  );
  const limit = evidenceInteger(pageRaw.limit, "page_info.limit", 1);
  const offset = evidenceInteger(pageRaw.offset, "page_info.offset", 0);
  const total = evidenceInteger(pageRaw.total, "page_info.total", 0);
  const expectedTotal = summary.code_allocations + summary.vanity_visits;
  if (
    limit > 100 ||
    offset > 10_000 ||
    typeof pageRaw.has_more !== "boolean" ||
    items.length > limit ||
    !Number.isSafeInteger(expectedTotal) ||
    total !== expectedTotal ||
    pageRaw.has_more !== offset + items.length < total
  ) {
    throw new TypeError(
      "inconsistent campaign direct-attribution evidence page_info",
    );
  }
  return {
    campaign_id: evidenceUUID(root.campaign_id, "campaign_id"),
    summary,
    items,
    page_info: { limit, offset, total, has_more: pageRaw.has_more },
  };
}
