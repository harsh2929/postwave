// Typed client for the domain-warmup scheduler (apps/api/internal/domain_warmup),
// mounted at /api/v1/domain-warmup*. The backend ramps a sending domain's daily
// volume over a warmup window (a per-domain schedule + a "today's quota"
// endpoint the send path can consult) with full CRUD — and had no client, so
// operators could not create or watch a warmup from the app. Shapes verified
// against internal/domain_warmup/domain_warmup.go.
import type { ApiRequester, ApiResult } from "./result";

export type WarmupStatus = "active" | "paused" | "completed" | string;

export interface WarmupPlan {
  id: string;
  domain: string;
  target_daily: number;
  days: number;
  started_on: string;
  status: WarmupStatus;
  /** Per-day cap ramp; length = days. */
  schedule: number[];
  last_sent_count: number;
  last_observed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateWarmupInput {
  domain: string;
  target_daily: number;
  days: number;
}

export interface CreatedWarmup {
  id: string;
  domain: string;
  target_daily: number;
  days: number;
}

// WarmupToday is the send path's "how much may this domain send today" answer.
export interface WarmupToday {
  domain: string;
  status: WarmupStatus;
  day_index: number;
  day_quota: number;
  sent_today: number;
  remaining: number;
  at_target: boolean;
}

interface PlansEnvelope {
  plans: WarmupPlan[];
  count: number;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

// createDomainWarmupApi wires typed methods over the 6 mounted routes.
export function createDomainWarmupApi(request: ApiRequester) {
  return {
    // GET /api/v1/domain-warmup — the tenant's warmup plans.
    list(): Promise<ApiResult<WarmupPlan[]>> {
      return request<PlansEnvelope>("/api/v1/domain-warmup").then((res) => {
        if (res.error) return res;
        const envelope = res.data as unknown as { plans?: unknown } | null;
        return { data: envelope?.plans as WarmupPlan[] };
      });
    },

    // POST /api/v1/domain-warmup — start warming a domain (admin).
    create(input: CreateWarmupInput): Promise<ApiResult<CreatedWarmup>> {
      return request<CreatedWarmup>(
        "/api/v1/domain-warmup",
        jsonInit("POST", input),
      );
    },

    // GET /api/v1/domain-warmup/{domain} — one plan.
    get(domain: string): Promise<ApiResult<WarmupPlan>> {
      return request<WarmupPlan>(
        `/api/v1/domain-warmup/${encodeURIComponent(domain)}`,
      );
    },

    // PATCH /api/v1/domain-warmup/{domain}/status — pause / resume (admin).
    setStatus(
      domain: string,
      status: string,
    ): Promise<ApiResult<{ status: string }>> {
      return request<{ status: string }>(
        `/api/v1/domain-warmup/${encodeURIComponent(domain)}/status`,
        jsonInit("PATCH", { status }),
      );
    },

    // DELETE /api/v1/domain-warmup/{domain} — stop + remove a plan (admin).
    remove(domain: string): Promise<ApiResult<void>> {
      return request<void>(
        `/api/v1/domain-warmup/${encodeURIComponent(domain)}`,
        jsonInit("DELETE"),
      );
    },

    // GET /api/v1/domain-warmup/{domain}/today — today's quota + usage.
    today(domain: string): Promise<ApiResult<WarmupToday>> {
      return request<WarmupToday>(
        `/api/v1/domain-warmup/${encodeURIComponent(domain)}/today`,
      );
    },
  };
}

export type DomainWarmupApi = ReturnType<typeof createDomainWarmupApi>;
