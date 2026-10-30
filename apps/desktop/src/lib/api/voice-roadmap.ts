import type { ApiResult } from "./result";

interface NativeFacadeRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type VoiceRoadmapRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: NativeFacadeRequestOptions,
) => Promise<ApiResult<T>>;

interface VoiceRoadmapDependencies {
  llmRequestOptions: NativeFacadeRequestOptions;
  sequencePositionPathSegment: (position: number) => string | null;
}

const OPAQUE_SUBSCRIBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/* ---------- R7 Voice roadmap (services/voice handlers) --------------- */

/** Deterministic variant resolution — services/voice variant_assignment.go.
 *  NOTE: the resolved arm comes back as `variant_key` (NOT `key` like
 *  the stored {@link SequenceEmailVariant}). */
export interface SequenceStepVariantAssignment {
  variant_key: string;
  subject: string;
  body: string;
  body_html?: string;
  weight_bp: number;
}

/** services/voice stuck.go — `{items,threshold_days}`. */
export interface SequenceStuckParticipant {
  subscriber_id: string;
  email: string;
  current_step: number;
  idle_days: number;
}

export interface SequenceStuckResponse {
  items: SequenceStuckParticipant[];
  threshold_days: number;
}

/** services/voice template_gen.go — generation.GeneratedTemplate. */
export interface VoiceGeneratedTemplate {
  name: string;
  subject: string;
  body_html: string;
  body_mjml?: string;
}

export function createVoiceRoadmapApi(
  request: VoiceRoadmapRequester,
  dependencies: VoiceRoadmapDependencies,
) {
  return {
    /** POST /api/v1/voice/sequences/{id}/steps/{position}/variant with an
     *  opaque subscriber_id JSON body. Identity never enters the URL. This is
     *  an authoring preview only while delivery/runtime parity is unqualified.
     *  `position` addresses the TOP-LEVEL step list (1-based); branch-step
     *  variants are not resolvable. */
    getStepVariant(
      sequenceId: string | number,
      position: number,
      subscriberId: string,
    ): Promise<ApiResult<SequenceStepVariantAssignment>> {
      const positionSegment =
        dependencies.sequencePositionPathSegment(position);
      if (!positionSegment) {
        return Promise.resolve({
          error: {
            kind: "invalid_config",
            message: "Sequence step position must be a positive integer.",
          },
        });
      }
      const normalizedSubscriberId = subscriberId.trim();
      if (!OPAQUE_SUBSCRIBER_ID_PATTERN.test(normalizedSubscriberId)) {
        return Promise.resolve({
          error: {
            kind: "invalid_config",
            message:
              "Subscriber ID must be an opaque 1-128 character identifier using letters, numbers, dots, underscores, or dashes.",
          },
        });
      }
      return request<SequenceStepVariantAssignment>(
        `/api/v1/voice/sequences/${encodeURIComponent(String(sequenceId))}/steps/${positionSegment}/variant`,
        {
          method: "POST",
          body: JSON.stringify({ subscriber_id: normalizedSubscriberId }),
        },
      );
    },
    /** GET /api/v1/voice/sequences/{id}/stuck[?days=N] — `days` overrides
     *  the sequence's stuck_after_days; 400 when neither is set; retryable 503
     *  when the durable Postgres projection is unavailable. Report capped at 500 rows. */
    listStuckParticipants(
      sequenceId: string | number,
      opts: { days?: number } = {},
    ): Promise<ApiResult<SequenceStuckResponse>> {
      const qs =
        opts.days != null
          ? `?days=${encodeURIComponent(String(opts.days))}`
          : "";
      return request<SequenceStuckResponse>(
        `/api/v1/voice/sequences/${encodeURIComponent(String(sequenceId))}/stuck${qs}`,
      );
    },
    /** POST /api/v1/voice/templates/generate `{brief,kind?,tone?}` —
     *  kind ∈ "newsletter"|"promo"|"announcement" (default newsletter);
     *  brief ≤ 8000 chars, tone ≤ 200. LLM-backed (60s, fire-once);
     *  429 with quota payload when the tenant AI quota is spent. */
    generateTemplate(input: {
      brief: string;
      kind?: "newsletter" | "promo" | "announcement";
      tone?: string;
    }): Promise<ApiResult<VoiceGeneratedTemplate>> {
      return request<VoiceGeneratedTemplate>(
        "/api/v1/voice/templates/generate",
        { method: "POST", body: JSON.stringify(input) },
        dependencies.llmRequestOptions,
      );
    },
  };
}
