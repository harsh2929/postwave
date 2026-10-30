/**
 * api/sequences.ts — transport for the Voice service's sequence surface.
 *
 * THE TYPED SDK RESOURCE IS THE TRANSPORT NOW, NOT A HAND-WRITTEN URL.
 * This module used to build all eight sequence paths itself, which put a second
 * definition of every route — and, worse, of the If-Match encoding the Voice
 * handler's optimistic concurrency depends on — one edit away from drifting on
 * this client alone. `parseSequenceIfMatch` answers 428 without the header and
 * 400 for anything that is not one strong ETag holding a positive integer, so
 * that drift would not be a subtle behaviour change; it would be a 400 on every
 * save, on phones only.
 *
 * THE SDK COULD NOT COVER THIS SURFACE, WHICH IS WHY THE COPY EXISTED.
 * `SequencesResource` had no participants, funnel or stuck read, and no way to
 * express the empty-draft create without also taking the generation fork. The
 * fix was to give the SDK those four (packages/sdk-ts/src/resources/
 * sequences.ts) rather than to keep a parallel client here.
 *
 * WHAT THIS MODULE STILL OWNS, AND WHY IT IS NOT A LEFTOVER
 *  - The MOBILE ERROR ENVELOPE. Every screen here branches on
 *    `res.error.status` / `.code`; the SDK throws. `sdkResource` is the one
 *    seam that converts, and it shares its implementation with `rawRequest`,
 *    so both paths map errors identically.
 *  - FAILING CLOSED ON A MISSING VERSION. The SDK's `sequenceIfMatch` THROWS on
 *    a non-positive version, which is right for a library and wrong inside a
 *    save handler — a thrown render is not a recoverable failure. So the
 *    precondition is checked with the SDK's own `isSequenceVersion` predicate
 *    and answered as an error RESULT with copy a person can act on. One
 *    definition of the rule, two shapes of answer.
 *
 * WHY `sdkResource` AND NOT `getClient()` INLINE. Reaching for `getClient` here
 * would pull `./sdkClient` — and therefore react-native — into this module's
 * import graph, and mobile's vitest runs in a NODE environment. The moment that
 * happens `src/api/sequences.test.ts` cannot import this file at all, and the
 * tests pinning the If-Match header and the fail-closed version guard vanish.
 * `./request` is the seam that test already mocks, so every impure call goes
 * through it.
 *
 * THE WIRE SHAPES LIVE IN ./sequenceWire. They carry decode-only legacy fields
 * the SDK's `SequenceStep` does not model, they are import-free, and they moved
 * out when this file passed its source budget. They are re-exported below so no
 * call site has to know that.
 */
import {
  isSequenceVersion,
  sequenceIfMatch,
  type RequestOptions,
} from "@postwave/sdk";

import { rawRequest, sdkResource, type AIApiResult } from "./request";
import type {
  SequenceDetailWire,
  SequenceListItem,
  SequenceListResponse,
  SequenceParticipantStatus,
  SequenceParticipantsPage,
  SequenceStepWire,
  SequenceUpdatePatch,
  StuckParticipantsReport,
} from "./sequenceWire";
import type { SequenceFunnelWire } from "@/lib/sequenceFunnel";
import { sequenceRowStepCount } from "@/lib/sequenceListView";

type MutationRequestOptions = Pick<RequestOptions, "idempotencyKey">;
type VersionedMutationRequestOptions = MutationRequestOptions & {
  expectedVersion: number;
};

export type {
  SequenceDetailWire,
  SequenceEmailVariantWire,
  SequenceGoalWire,
  SequenceListItem,
  SequenceListResponse,
  SequenceParticipantStatus,
  SequenceParticipantWire,
  SequenceParticipantsPage,
  SequenceStepWire,
  SequenceTriggerKind,
  SequenceTriggerWire,
  SequenceUpdatePatch,
  StuckParticipantWire,
  StuckParticipantsReport,
} from "./sequenceWire";
export { normalizeSequenceListResponse } from "./sequenceWire";

/**
 * Row step count. Implementation lives in the pure `lib/sequenceListView`
 * module (no react-native reachable) so it is directly unit-testable and the
 * list screen's sort shares exactly one definition with the row label.
 */
export function sequenceStepCount(item: SequenceListItem): number {
  return sequenceRowStepCount(item);
}

/**
 * GET /api/v1/voice/sequences — list view.
 *
 * The SDK types this `Sequence[]`, but the handler has answered a bare array
 * AND an envelope over its life, so the response is cast to the wider union
 * this module has always accepted and narrowed by
 * `normalizeSequenceListResponse`. Trusting the SDK's narrower type here would
 * turn an envelope into a silently empty list — the exact failure class that
 * fills the mobile logic audit.
 */
export async function listSequences(): Promise<
  AIApiResult<SequenceListResponse>
> {
  return sdkResource<SequenceListResponse>(
    async (client) =>
      (await client.sequences.list()) as unknown as SequenceListResponse,
  );
}

/**
 * POST /api/v1/voice/sequences — create a new EMPTY DRAFT sequence.
 *
 * The route is proxied at apps/api/main.go:3922 behind `write:campaigns` and
 * lands on `Handler.generateSequence` (services/voice/internal/handlers/
 * sequences.go:569). That handler is a fork, not a generator: with
 * `template_id` ABSENT — and profile / variables / style_controls absent with
 * it — it delegates to `createDraftSequence` (:693), which explicitly "avoids
 * the LLM/template engine and therefore does not spend AI quota". Sending a
 * `template_id` would instead take the generation branch, which today answers
 * 503 in production ("template-backed sequence generation is unavailable until
 * a durable worker is configured", :634). So this body must stay minimal.
 *
 * WHY THERE IS NO `description`. `generateSequenceRequest` has no such field
 * and the body is decoded with `DisallowUnknownFields` (:575 →
 * httpbody.DecodeJSONStrict → dec.DisallowUnknownFields). This function used
 * to send `description: ""` unconditionally, which made EVERY create — the
 * live one and every offline replay of `OFFLINE_MUTATION_KEYS.sequenceCreate`
 * — a guaranteed 400 `json: unknown field "description"`.
 *
 * `steps` defaults to `[]`: `Steps` is a `*[]Step`, so an absent field and an
 * empty array are the same outcome, and being explicit documents that the
 * blank-create path makes a SHELL. Status is left unset — `NormalizeStatus("")`
 * returns `draft` (sequencecontract/contract.go:42), and `active` is refused
 * on create (:709), so nothing this function can send is ever live.
 *
 * WHY IT ALSO ACCEPTS STEPS. `createDraftSequence` runs `validateSteps` and
 * persists whatever it is given (:706-716), so the SAME no-LLM fork saves a
 * reviewed AI draft. That is the whole of the save half of AUTOMATION#15: the
 * drafting endpoint persists nothing, so the emails an operator kept are
 * written by this call and by nothing else. Callers pass steps built by
 * `lib/sequenceDraft.draftEmailsToWireSteps`, whose dense 1..N positions are a
 * requirement — `validateSteps` rejects a duplicate or a zero position.
 *
 * Responds 201 with the whole persisted sequence, not just an id.
 */
export async function createSequence(
  input: { name: string; steps?: SequenceStepWire[] | undefined },
  options?: MutationRequestOptions,
): Promise<AIApiResult<SequenceDetailWire>> {
  // `client.sequences.createDraft` sends exactly this body and is the SDK's
  // name for the no-LLM fork; the low-level call is kept only because the
  // resource method has no idempotency-key parameter, and an offline replay of
  // OFFLINE_MUTATION_KEYS.sequenceCreate MUST carry one or a flaky reconnect
  // creates the same draft twice.
  return rawRequest<SequenceDetailWire>(
    "POST",
    "/api/v1/voice/sequences",
    { name: input.name, steps: input.steps ?? [] },
    options,
  );
}

/** GET /api/v1/voice/sequences/{id} — full detail. */
export async function getSequence(
  id: string,
): Promise<AIApiResult<SequenceDetailWire>> {
  return sdkResource<SequenceDetailWire>(
    async (client) =>
      (await client.sequences.get(id)) as unknown as SequenceDetailWire,
  );
}

/* ------------------------------------------------------------------ *
 * Participants + stuck report
 *
 * Both require read:campaigns AND read:subscribers (apps/api/main.go:3901,
 * :3904) — a token holding only one of the two gets a 403, which is why the
 * screens treat 403 as a scope answer rather than a fault.
 *
 * Both are DERIVED from `sequence_funnel_events`, the only per-(sequence,
 * subscriber) table the platform writes (services/voice/internal/handlers/
 * participants.go:1-10). With no qualified delivery runtime nothing writes
 * that table, so an empty list here is the honest, expected answer today —
 * and the zero-states say so instead of implying a load failure.
 * ------------------------------------------------------------------ */

/** GET /api/v1/voice/sequences/{id}/participants */
export function listSequenceParticipants(
  id: string,
  params: {
    status?: SequenceParticipantStatus | undefined;
    page?: number | undefined;
    perPage?: number | undefined;
  } = {},
): Promise<AIApiResult<SequenceParticipantsPage>> {
  return sdkResource<SequenceParticipantsPage>(
    async (client) =>
      (await client.sequences.participants(id, {
        // exactOptionalPropertyTypes: an explicit `undefined` is a type error,
        // so each filter is spread only when the caller actually set it.
        ...(params.status !== undefined ? { status: params.status } : {}),
        ...(params.page !== undefined ? { page: params.page } : {}),
        ...(params.perPage !== undefined ? { perPage: params.perPage } : {}),
      })) as unknown as SequenceParticipantsPage,
  );
}

/**
 * GET /api/v1/voice/sequences/{id}/funnel — per-step reach/open/click.
 *
 * Mounted at apps/api/internal/server/analytics_realtime_routes.go:62 with
 * `read:reports` AND the heavy-read limiter (a different scope from every
 * other sequence read, which is why a token that can see the topology can
 * legitimately get a 403 here).
 *
 * Rows come from `sequence_funnel_events`, which NOTHING in this repository
 * writes (migration 0367's header says so explicitly), so the report is
 * currently empty for every tenant. lib/sequenceFunnel reports that as
 * `hasData: false` so the UI can say it rather than draw confident zeros.
 */
export function getSequenceFunnel(
  id: string,
): Promise<AIApiResult<SequenceFunnelWire>> {
  return sdkResource<SequenceFunnelWire>(
    async (client) =>
      (await client.sequences.funnel(id)) as unknown as SequenceFunnelWire,
  );
}

/**
 * GET /api/v1/voice/sequences/{id}/stuck[?days=N].
 *
 * The handler answers 400 — not an empty list — when the sequence has no
 * `stuck_after_days` configured and no `?days=` override is supplied
 * (services/voice/internal/handlers/stuck.go:199-202). The caller must render
 * that as "detection is off", never as a failure.
 */
export function listStuckParticipants(
  id: string,
  days?: number | undefined,
): Promise<AIApiResult<StuckParticipantsReport>> {
  return sdkResource<StuckParticipantsReport>(
    async (client) =>
      (await client.sequences.stuck(id, days)) as unknown as StuckParticipantsReport,
  );
}

/**
 * DELETE /api/v1/voice/sequences/{id} — permanent, with optimistic
 * concurrency (apps/api/main.go:3924, write:campaigns).
 *
 * The Voice handler REQUIRES If-Match: `parseSequenceIfMatch` answers 428
 * without one and 400 for anything that is not one exact strong ETag holding
 * a positive integer, and `DeleteWithVersion` answers 412 when the row moved
 * on (services/voice/internal/handlers/sequences.go:1198-1230). So this
 * mirrors `updateSequence` and fails closed client-side rather than sending a
 * request the server is certain to reject.
 *
 * There is no undo endpoint — the row is gone — which is why the caller pairs
 * this with a ConfirmSheet rather than the toast-undo pattern the kit prefers
 * for reversible destructive actions.
 */
export async function deleteSequence(
  id: string,
  options: VersionedMutationRequestOptions,
): Promise<AIApiResult<null>> {
  const guarded = versionGuard(options.expectedVersion, "deleting");
  if (guarded) return guarded;
  return rawRequest<null>(
    "DELETE",
    `/api/v1/voice/sequences/${encodeURIComponent(id)}`,
    undefined,
    {
      ...(options.idempotencyKey !== undefined
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
      headers: { "If-Match": sequenceIfMatch(options.expectedVersion) },
    },
  );
}

/** PATCH /api/v1/voice/sequences/{id} — partial update. */
export async function updateSequence(
  id: string,
  patch: SequenceUpdatePatch,
  options: VersionedMutationRequestOptions,
): Promise<AIApiResult<SequenceDetailWire>> {
  const guarded = versionGuard(options.expectedVersion, "saving");
  if (guarded) return guarded;
  return rawRequest<SequenceDetailWire>(
    "PATCH",
    `/api/v1/voice/sequences/${encodeURIComponent(id)}`,
    patch,
    {
      ...(options.idempotencyKey !== undefined
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
      headers: { "If-Match": sequenceIfMatch(options.expectedVersion) },
    },
  );
}

/**
 * Refuse a mutation the server is certain to reject, as a RESULT.
 *
 * The predicate is the SDK's `isSequenceVersion` — the same one
 * `sequenceIfMatch` enforces — so this cannot drift from the encoder that runs
 * immediately after it. What differs is the SHAPE of the answer: the SDK
 * throws, which is right for a library and wrong inside a save handler, where a
 * thrown render is not a recoverable failure. `status: 0` marks it as a
 * client-side refusal that never reached the network, which is how the callers
 * already distinguish "we did not send this" from a server 412.
 *
 * Returns null when the version is usable, so the caller reads as a guard.
 */
function versionGuard(
  expectedVersion: number,
  verb: "saving" | "deleting",
): AIApiResult<never> | null {
  if (isSequenceVersion(expectedVersion)) return null;
  return {
    data: null,
    error: {
      status: 0,
      message: `A fresh sequence version is required before ${verb}. Reload the sequence and try again.`,
    },
  };
}
