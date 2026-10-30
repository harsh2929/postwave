// Typed client for the Consent-Safe Activation Firewall's compliance list
// (apps/api/internal/activation_firewall), mounted at GET
// /api/v1/activation-exclusions. The firewall partitions activation-audience
// members into kept / excluded by consent + suppression, and every excluded
// member carries the governing rule — a compliance receipt operators need to
// answer "why wasn't this person messaged?". It had no client. Shapes verified
// against activation_firewall/repo.go + handlers.go.
import type { ApiRequester, ApiResult } from "./result";

export interface ExclusionReceipt {
  id: number;
  run_id: string;
  run_type: string;
  subscriber_email: string;
  /** The class of rule that excluded them, e.g. "consent" | "suppression". */
  rule_class: string;
  rule_reason: string;
  consent_event_id?: number;
  purpose: string;
  destination_type: string;
  excluded_at: string;
  signature: string;
}

interface ExclusionsEnvelope {
  items: ExclusionReceipt[];
  count: number;
}

// createActivationExclusionsApi wires the compliance list route.
export function createActivationExclusionsApi(request: ApiRequester) {
  return {
    // GET /api/v1/activation-exclusions?since= — excluded members + the rule
    // that excluded each. `since` (RFC3339) narrows the window when supplied.
    list(since?: string): Promise<ApiResult<ExclusionReceipt[]>> {
      const q = since ? `?since=${encodeURIComponent(since)}` : "";
      return request<ExclusionsEnvelope>(`/api/v1/activation-exclusions${q}`).then((res) =>
        res.error ? res : { data: res.data.items ?? [] },
      );
    },
  };
}

export type ActivationExclusionsApi = ReturnType<typeof createActivationExclusionsApi>;
