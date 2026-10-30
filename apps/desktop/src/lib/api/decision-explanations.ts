import { apiRequest, type ApiResult } from "../api-client";
import type { ApiErr } from "./result";
import {
  responseContractFailure,
  responseIdentityMatches,
  responseIdentityMismatch,
} from "./subscriber-response-integrity";

/** One stored automated-decision explanation. Mirrors
 *  subscribers.DecisionExplanation (migration 0951). */
export interface DecisionExplanation {
  id: string;
  subscriber_id: string;
  /** 'segment' | 'campaign'. */
  decision_type: string;
  target_id: string;
  reasoning_snapshot: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** GET /api/v1/subscribers/{id}/decision-explanations response. */
export interface DecisionExplanationList {
  subscriber_id: string;
  items: DecisionExplanation[];
}

/** POST /api/v1/subscribers/{id}/decision-explanations body. Mirrors
 *  subscribers.RecordDecisionExplanationInput: upserts one snapshot per
 *  (subscriber, decision_type, target_id). */
export interface RecordDecisionExplanationInput {
  /** 'segment' | 'campaign'. */
  decision_type: string;
  /** The segment/campaign id the decision concerns. */
  target_id: string;
  /** Freeform human-readable reasoning payload. */
  reasoning_snapshot?: Record<string, unknown>;
}

/** One leaf condition of a segment, evaluated live against the
 *  subscriber, with a human-readable reason (SUB-070). */
export interface SegmentConditionResult {
  field: string;
  comparator: string;
  value?: string;
  matched: boolean;
  description: string;
}

/** Whether the subscriber belongs to one segment and which conditions
 *  matched. Mirrors subscribers.SegmentMembership. */
export interface SegmentMembership {
  segment_id: string;
  segment_name: string;
  is_member: boolean;
  matched_count: number;
  total_conditions: number;
  /** e.g. "matched 3 of 5 conditions in 'High-Engagement'". */
  summary: string;
  conditions: SegmentConditionResult[];
}

/** GET /api/v1/subscribers/{id}/segment-membership response: every
 *  tenant segment with the subscriber's live membership + reasons. */
export interface SegmentMembershipResponse {
  subscriber_id: string;
  segments: SegmentMembership[];
}

function validateDecisionExplanationList(
  data: DecisionExplanationList,
  subscriberId: string | number,
): ApiErr | null {
  if (typeof data?.subscriber_id !== "string" || !Array.isArray(data.items)) {
    return responseContractFailure(
      "The decision-explanation service returned an incomplete response. The previous verified explanations were kept; retry the request.",
    );
  }
  if (!responseIdentityMatches(subscriberId, data.subscriber_id)) {
    return responseIdentityMismatch("subscriber");
  }
  const ids = new Set<string>();
  for (const item of data.items) {
    if (
      typeof item?.id !== "string" ||
      item.id.trim() === "" ||
      ids.has(item.id)
    ) {
      return responseContractFailure(
        "The decision-explanation service returned an invalid explanation identity. The previous verified explanations were kept; retry the request.",
      );
    }
    ids.add(item.id);
    if (!responseIdentityMatches(subscriberId, item.subscriber_id)) {
      return responseIdentityMismatch("subscriber");
    }
  }
  return null;
}

export const decisionExplanationsApi = {
  /** GET /api/v1/subscribers/{id}/decision-explanations - stored
   *  decision snapshots, newest-first. Read scope. */
  async getSubscriberDecisionExplanations(
    subscriberId: string | number,
  ): Promise<ApiResult<DecisionExplanationList>> {
    const response = await apiRequest<DecisionExplanationList>(
      `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/decision-explanations`,
    );
    if (response.error) return response;
    return (
      validateDecisionExplanationList(response.data, subscriberId) ?? response
    );
  },
  /** GET /api/v1/subscribers/{id}/segment-membership - live segment
   *  membership + per-condition reasons (the headline
   *  right-to-explanation surface). Read scope. */
  async getSegmentMembership(
    subscriberId: string | number,
  ): Promise<ApiResult<SegmentMembershipResponse>> {
    const response = await apiRequest<SegmentMembershipResponse>(
      `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/segment-membership`,
    );
    if (response.error) return response;
    if (
      typeof response.data?.subscriber_id !== "string" ||
      !Array.isArray(response.data.segments)
    ) {
      return responseContractFailure(
        "The segment-membership service returned an incomplete response. The previous verified decisions were kept; retry the request.",
      );
    }
    if (!responseIdentityMatches(subscriberId, response.data.subscriber_id)) {
      return responseIdentityMismatch("subscriber");
    }
    if (
      response.data.segments.some(
        (segment) =>
          typeof segment?.segment_id !== "string" ||
          segment.segment_id.trim() === "",
      ) ||
      new Set(response.data.segments.map((segment) => segment.segment_id))
        .size !== response.data.segments.length
    ) {
      return responseContractFailure(
        "The segment-membership service returned invalid or duplicate segment identities. The previous verified decisions were kept; retry the request.",
      );
    }
    return response;
  },
  /** POST /api/v1/subscribers/{id}/decision-explanations - upsert one
   *  recorded decision snapshot (admin/automation path). Returns the
   *  refreshed list view (201). Write scope; requireOnline so a record
   *  never replays silently on reconnect. */
  async recordSubscriberDecisionExplanation(
    subscriberId: string | number,
    input: RecordDecisionExplanationInput,
  ): Promise<ApiResult<DecisionExplanationList>> {
    const response = await apiRequest<DecisionExplanationList>(
      `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/decision-explanations`,
      { method: "POST", body: JSON.stringify(input) },
      { requireOnline: true },
    );
    if (response.error) return response;
    return (
      validateDecisionExplanationList(response.data, subscriberId) ?? response
    );
  },
};
