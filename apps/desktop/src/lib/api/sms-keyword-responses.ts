import { apiRequest, type ApiResult } from "../api-client";

/** Inbound-keyword action. The action records match/state intent; outbound
 * confirmation dispatch is represented separately and is currently held. */
export type SmsKeywordAction = "reply_only" | "opt_out";

/**
 * Mirrors `sms_keyword_responses` — wire shape verified against the
 * live Go handlers. `response_body` is canonical; `response_text` is
 * echoed as a legacy alias.
 */
export interface SmsKeywordResponseRow {
  id: string;
  /** Canonical tenant identity; every private row is bound before rendering. */
  tenant_id: string;
  keyword: string;
  /** Canonical reply body. */
  response_body: string;
  /** Legacy alias of response_body (older rows / clients). */
  response_text: string;
  action: SmsKeywordAction;
  enabled: boolean;
  /** Independent outbound-effect evidence; `enabled` is not send evidence. */
  autoReplyDispatchAvailable?: boolean;
  autoReplyDispatchUnavailableReason?:
    | "sms_auto_reply_dispatch_release_held"
    | undefined;
  /** Historical consent attribution count; never interpreted as live dispatch. */
  opt_in_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * Body for POST / PATCH /api/v1/sms/keyword-responses. Reserved
 * carrier keywords (STOP/HELP/etc.) 422 with code `reserved_keyword`.
 */
export interface SmsKeywordResponseInput {
  keyword: string;
  response_body: string;
  action: SmsKeywordAction;
  enabled?: boolean;
}

export type SmsKeywordResponsePatchInput = Partial<SmsKeywordResponseInput> & {
  /** Compare-and-swap token captured from the exact row being edited. */
  expected_updated_at: string;
};

export interface SmsKeywordDeleteReceipt {
  ok: true;
  tenantId: string;
  id: string;
}

export const smsKeywordResponsesApi = {
  /** GET /api/v1/sms/keyword-responses -> strict tenant-bound envelope. */
  list(
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<{ tenantId: string; items: SmsKeywordResponseRow[] }>> {
    return apiRequest<{ tenantId: string; items: SmsKeywordResponseRow[] }>(
      "/api/v1/sms/keyword-responses",
      opts.signal ? { signal: opts.signal } : undefined,
    );
  },
  /** POST /api/v1/sms/keyword-responses, 422 `reserved_keyword` for
   *  carrier-reserved words (STOP, HELP, ...). */
  create(
    input: SmsKeywordResponseInput,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SmsKeywordResponseRow>> {
    return apiRequest<SmsKeywordResponseRow>("/api/v1/sms/keyword-responses", {
      method: "POST",
      body: JSON.stringify(input),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  },
  /** PATCH /api/v1/sms/keyword-responses/{id} — partial update. */
  update(
    id: string,
    input: SmsKeywordResponsePatchInput,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SmsKeywordResponseRow>> {
    return apiRequest<SmsKeywordResponseRow>(
      `/api/v1/sms/keyword-responses/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
  },
  /** DELETE /api/v1/sms/keyword-responses/{id}. */
  remove(
    id: string,
    input: { expected_updated_at: string },
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SmsKeywordDeleteReceipt>> {
    return apiRequest<SmsKeywordDeleteReceipt>(
      `/api/v1/sms/keyword-responses/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        body: JSON.stringify(input),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
  },
};
