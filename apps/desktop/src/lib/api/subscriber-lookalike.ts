import { apiRequest, type ApiRequestOpts, type ApiResult } from "../api-client";
import {
  responseContractFailure,
  responseIdentityMatches,
  responseIdentityMismatch,
} from "./subscriber-response-integrity";

export type SubscriberLookalikeStatus =
  | "pending"
  | "running"
  | "ready"
  | "failed";

/** Aggregate metadata for one first-party modeled audience. Ranked subscriber
 * identities are deliberately absent from this header. */
export interface SubscriberLookalikeAudience {
  id: string;
  name: string;
  seed_segment_id: string;
  size_requested: number;
  member_count: number;
  seed_count: number;
  confidence_threshold?: number;
  model_version: string;
  status: SubscriberLookalikeStatus;
  exported_destination_id?: string;
  payload: Record<string, unknown>;
  error?: string;
  created_at: string;
  updated_at: string;
}

export interface SubscriberLookalikeMember {
  subscriber_id: string;
  email: string;
  similarity_score: number;
  rank: number;
  features: Record<string, unknown>;
}

/** Detail/status response. `pii_included` is false by default and members are
 * empty; callers must explicitly opt in before direct identities are returned. */
export interface SubscriberLookalikeAudienceDetail {
  audience: SubscriberLookalikeAudience;
  members: SubscriberLookalikeMember[];
  page: number;
  per_page: number;
  pii_included: boolean;
}

export interface CreateSubscriberLookalikeInput {
  name: string;
  seed_segment_id: string;
  /** 100..10000; defaults to 1000. */
  size?: number;
  /** Optional similarity floor. When supplied the supported range is 0.5..1. */
  confidence_threshold?: number | null;
  /** Explicit acknowledgement of the first-party data-use notice in the UI. */
  data_use_acknowledged: true;
}

interface RequestOptions {
  signal?: AbortSignal;
}

export interface WaitForSubscriberLookalikeOptions extends RequestOptions {
  intervalMs?: number;
  maxPolls?: number;
  /** Test seam; production uses an abort-aware timer. */
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<boolean>;
}

const LOOKALIKE_CREATE_OPTS = {
  timeoutMs: 60_000,
  maxAttempts: 1,
  requireOnline: true,
} satisfies ApiRequestOpts;

const LOOKALIKE_STATUSES = new Set<SubscriberLookalikeStatus>([
  "pending",
  "running",
  "ready",
  "failed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isLookalikeAudience(
  value: unknown,
): value is SubscriberLookalikeAudience {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.name === "string" &&
    typeof value.seed_segment_id === "string" &&
    value.seed_segment_id.trim().length > 0 &&
    isNonNegativeInteger(value.size_requested) &&
    value.size_requested >= 100 &&
    value.size_requested <= 10_000 &&
    isNonNegativeInteger(value.member_count) &&
    value.member_count <= value.size_requested &&
    isNonNegativeInteger(value.seed_count) &&
    typeof value.model_version === "string" &&
    value.model_version.trim().length > 0 &&
    typeof value.status === "string" &&
    LOOKALIKE_STATUSES.has(value.status as SubscriberLookalikeStatus) &&
    (value.confidence_threshold === undefined ||
      (typeof value.confidence_threshold === "number" &&
        Number.isFinite(value.confidence_threshold) &&
        value.confidence_threshold >= 0.5 &&
        value.confidence_threshold <= 1)) &&
    (value.exported_destination_id === undefined ||
      (typeof value.exported_destination_id === "string" &&
        value.exported_destination_id.trim().length > 0)) &&
    isRecord(value.payload) &&
    typeof value.created_at === "string" &&
    !Number.isNaN(Date.parse(value.created_at)) &&
    typeof value.updated_at === "string" &&
    !Number.isNaN(Date.parse(value.updated_at)) &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function invalidAudienceContract<T>(detail: string): ApiResult<T> {
  return responseContractFailure(
    `The lookalike service returned an incomplete response. ${detail}`,
  );
}

function abortedResult<T>(): ApiResult<T> {
  return {
    error: {
      kind: "network",
      code: "aborted",
      message:
        "Status checking was stopped. The server-side job was not cancelled.",
    },
    retryability: "not-retryable",
  };
}

async function abortAwareWait(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  return new Promise<boolean>((resolve) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function getLookalike(
  id: string,
  opts: {
    page?: number;
    perPage?: number;
    includePII?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<ApiResult<SubscriberLookalikeAudienceDetail>> {
  const params = new URLSearchParams();
  if (opts.page) params.set("page", String(opts.page));
  if (opts.perPage) params.set("per_page", String(opts.perPage));
  if (opts.includePII) params.set("include_pii", "true");
  const qs = params.toString();
  const response = await apiRequest<SubscriberLookalikeAudienceDetail>(
    `/api/v1/subscribers/lookalike/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`,
    undefined,
    opts.signal ? { signal: opts.signal } : undefined,
  );
  if (response.error) return response;
  const detail = response.data;
  if (
    !isRecord(detail) ||
    !isLookalikeAudience(detail.audience) ||
    !Array.isArray(detail.members) ||
    !isNonNegativeInteger(detail.page) ||
    detail.page < 1 ||
    !isNonNegativeInteger(detail.per_page) ||
    detail.per_page < 1 ||
    typeof detail.pii_included !== "boolean" ||
    (!detail.pii_included && detail.members.length > 0)
  ) {
    return invalidAudienceContract(
      "No unverified audience or subscriber identities were shown.",
    );
  }
  if (!responseIdentityMatches(id, detail.audience.id)) {
    return responseIdentityMismatch("lookalike audience");
  }
  return response;
}

export const lookalikeApi = {
  async create(
    input: CreateSubscriberLookalikeInput,
    options: RequestOptions = {},
  ): Promise<ApiResult<SubscriberLookalikeAudience>> {
    const response = await apiRequest<SubscriberLookalikeAudience>(
      "/api/v1/subscribers/lookalike",
      { method: "POST", body: JSON.stringify(input) },
      { ...LOOKALIKE_CREATE_OPTS, signal: options.signal },
    );
    if (response.error) return response;
    if (!isLookalikeAudience(response.data)) {
      return invalidAudienceContract("No unverified audience was shown.");
    }
    if (
      !responseIdentityMatches(
        input.seed_segment_id,
        response.data.seed_segment_id,
      )
    ) {
      return responseIdentityMismatch("lookalike audience");
    }
    if (
      input.size !== undefined &&
      response.data.size_requested !== input.size
    ) {
      return invalidAudienceContract(
        "The returned target size did not match the submitted request.",
      );
    }
    return response;
  },

  async list(
    options: RequestOptions = {},
  ): Promise<ApiResult<{ items: SubscriberLookalikeAudience[] }>> {
    const response = await apiRequest<{
      items: SubscriberLookalikeAudience[];
    }>(
      "/api/v1/subscribers/lookalike",
      undefined,
      options.signal ? { signal: options.signal } : undefined,
    );
    if (response.error) return response;
    if (
      !isRecord(response.data) ||
      !Array.isArray(response.data.items) ||
      !response.data.items.every(isLookalikeAudience) ||
      new Set(response.data.items.map((item) => item.id)).size !==
        response.data.items.length
    ) {
      return invalidAudienceContract("No unverified audience list was shown.");
    }
    return response;
  },

  get: getLookalike,

  async waitForTerminal(
    id: string,
    options: WaitForSubscriberLookalikeOptions = {},
  ): Promise<ApiResult<SubscriberLookalikeAudience>> {
    const intervalMs = Math.max(100, options.intervalMs ?? 1_250);
    const maxPolls = Math.max(1, options.maxPolls ?? 96);
    const wait = options.wait ?? abortAwareWait;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (!(await wait(poll === 0 ? 0 : intervalMs, options.signal))) {
        return abortedResult();
      }
      const response = await getLookalike(id, {
        perPage: 1,
        signal: options.signal,
      });
      if (response.error) return response;
      const audience = response.data.audience;
      if (audience.status === "ready" || audience.status === "failed") {
        return { data: audience };
      }
    }
    return {
      error: {
        kind: "timeout",
        code: "lookalike_poll_timeout",
        message:
          "Generation is still running. Stop waiting or retry the status check; do not submit a duplicate audience.",
      },
      retryability: "manual",
    };
  },

  remove(id: string, options: RequestOptions = {}): Promise<ApiResult<void>> {
    return apiRequest<void>(
      `/api/v1/subscribers/lookalike/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      { requireOnline: true, signal: options.signal },
    );
  },

  async export(
    id: string,
    destinationId: string,
    options: RequestOptions = {},
  ): Promise<ApiResult<SubscriberLookalikeAudience>> {
    const response = await apiRequest<SubscriberLookalikeAudience>(
      `/api/v1/subscribers/lookalike/${encodeURIComponent(id)}/export`,
      {
        method: "POST",
        body: JSON.stringify({ destination_id: destinationId }),
      },
      { requireOnline: true, signal: options.signal },
    );
    if (response.error) return response;
    if (!isLookalikeAudience(response.data)) {
      return invalidAudienceContract(
        "No unverified destination handoff was shown.",
      );
    }
    if (
      !responseIdentityMatches(id, response.data.id) ||
      !response.data.exported_destination_id ||
      !responseIdentityMatches(
        destinationId,
        response.data.exported_destination_id,
      )
    ) {
      return responseIdentityMismatch("lookalike audience");
    }
    return response;
  },
};
