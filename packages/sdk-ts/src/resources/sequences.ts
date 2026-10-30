import { Resource } from "./_base.js";
import { RequestAbortedError } from "../errors.js";
import type {
  GeneratedEmail,
  GenerateRequest,
  RegenerateRequest,
  Sequence,
  SequenceStep,
} from "../types.js";

export interface UpdateDraftSequenceRequest {
  name?: string;
  status?: "draft";
  emails?: GeneratedEmail[];
  steps?: SequenceStep[];
}

/** Archiving is an exclusive terminal transition; it cannot carry edits. */
export interface ArchiveSequenceRequest {
  status: "archived";
  name?: never;
  emails?: never;
  steps?: never;
}

export type UpdateSequenceRequest =
  | UpdateDraftSequenceRequest
  | ArchiveSequenceRequest;

/**
 * SequenceJob is the polling shape for the async generation flow.
 * `sequence_id` is null while pending/running and populated on
 * succeeded; `email_position` is set only for regeneration jobs.
 */
export interface SequenceJob {
  id: string;
  tenant_id: string;
  sequence_id?: string;
  email_position?: number;
  status: "pending" | "running" | "succeeded" | "failed";
  error_message?: string;
  started_at?: string;
  finished_at?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Async-mode response from `generate()` / `regenerate()` when the
 * server has SequenceJobs wired. Returns immediately with a job_id;
 * caller polls `getJob(id)` for terminal state.
 */
export interface SequenceJobAck {
  job_id: string;
  status: "pending";
}

export interface SequenceWaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * The empty-draft create.
 *
 * `POST /api/v1/voice/sequences` is a FORK, not a generator: with `template_id`
 * absent — and profile/variables/style_controls absent with it — the handler
 * delegates to `createDraftSequence` (services/voice/internal/handlers/
 * sequences.go), which explicitly avoids the LLM and spends no AI quota.
 * Sending a `template_id` takes the generation branch, which answers 503 until
 * a durable worker is configured.
 *
 * Typing it separately from `GenerateRequest` is what makes that fork visible:
 * a caller who only wants a named shell should not have to know which fields
 * silently change the endpoint's behaviour. Note the absence of `description`
 * — the request is decoded with DisallowUnknownFields, so a body carrying one
 * is a guaranteed 400 before any other field is read.
 */
export interface CreateDraftSequenceRequest {
  name: string;
  steps?: SequenceStep[];
  stuck_after_days?: number;
}

/** One row of `GET /sequences/{id}/participants`. */
export interface SequenceParticipant {
  /** Empty when the subscriber row is gone; such rows read as "exited". */
  subscriber_id: string;
  email: string;
  status: SequenceParticipantStatus | (string & {});
  current_step: number;
  entered_at: string;
  last_event_at: string;
}

export type SequenceParticipantStatus =
  | "active"
  | "completed"
  | "completed_goal"
  | "exited";

export interface SequenceParticipantsPage {
  items: SequenceParticipant[];
  total: number;
  page: number;
  per_page: number;
}

export interface SequenceParticipantsQuery {
  status?: SequenceParticipantStatus | (string & {});
  /** `entered_at`, `last_event_at`, `current_step`, each with an `_asc`/`_desc` variant. */
  sort?: string;
  page?: number;
  perPage?: number;
}

/** One row of `GET /sequences/{id}/funnel`. */
export interface SequenceFunnelStep {
  /** Absent on rows written before step ids existed; match on position then. */
  step_id?: string;
  position?: number;
  reached?: number;
  opened?: number;
  clicked?: number;
}

export interface SequenceFunnel {
  sequence_id?: string;
  steps?: SequenceFunnelStep[];
}

export interface StuckSequenceParticipant {
  subscriber_id: string;
  email: string;
  current_step: number;
  idle_days: number;
}

export interface StuckParticipantsReport {
  items: StuckSequenceParticipant[];
  threshold_days: number;
}

/**
 * Type guard distinguishing the two `generate()` response shapes.
 * Async deployments return `SequenceJobAck`; legacy/dev synchronous
 * mode returns the full `Sequence` body inline.
 */
export function isSequenceJobAck(
  v: Sequence | SequenceJobAck,
): v is SequenceJobAck {
  return typeof (v as SequenceJobAck).job_id === "string";
}

export class SequencesResource extends Resource {
  list(): Promise<Sequence[]> {
    return this.client.request("GET", "/api/v1/voice/sequences");
  }

  get(id: string): Promise<Sequence> {
    return this.client.request("GET", `/api/v1/voice/sequences/${encodeURIComponent(id)}`);
  }

  /**
   * Kick off generation. Async deployments return `{job_id, status}`;
   * sync/dev mode returns the full `Sequence`. Branch with
   * `isSequenceJobAck()`.
   */
  generate(req: GenerateRequest): Promise<Sequence | SequenceJobAck> {
    return this.client.request("POST", "/api/v1/voice/sequences", { body: req });
  }

  /**
   * Create an EMPTY DRAFT (or one seeded with steps you already have).
   *
   * The same route as `generate()`, deliberately narrowed: no `template_id`,
   * no profile/variables/style_controls, so the handler takes the
   * `createDraftSequence` fork and never touches the LLM. Always resolves to
   * the persisted `Sequence` — the draft fork has no async job to poll.
   *
   * `steps` defaults to `[]` rather than being omitted: `Steps` is a `*[]Step`
   * server-side, so both mean the same thing, and being explicit is what
   * documents that this creates a shell.
   */
  createDraft(req: CreateDraftSequenceRequest): Promise<Sequence> {
    return this.client.request("POST", "/api/v1/voice/sequences", {
      body: { steps: [], ...req },
    });
  }

  /**
   * Regenerate one email in an existing sequence. Async returns
   * `SequenceJobAck`; sync returns the produced `GeneratedEmail`.
   */
  regenerate(
    id: string,
    position: number,
    req: RegenerateRequest = {},
  ): Promise<GeneratedEmail | SequenceJobAck> {
    return this.client.request(
      "POST",
      `/api/v1/voice/sequences/${encodeURIComponent(id)}/regenerate/${sequencePositionPathSegment(position)}`,
      { body: req },
    );
  }

  /** Poll a sequence-generation job. */
  getJob(jobID: string, opts: { signal?: AbortSignal } = {}): Promise<SequenceJob> {
    return this.client.request(
      "GET",
      `/api/v1/voice/sequences/jobs/${encodeURIComponent(jobID)}`,
      { signal: opts.signal },
    );
  }

  /**
   * Convenience wrapper: poll `getJob(id)` until terminal status,
   * resolving with the final job. Caller decides what to do with
   * `failed`. Backoff is constant 2s; the typical Gemini run lands
   * in 10-30s so 5-15 polls.
   */
  async waitForJob(
    jobID: string,
    opts: SequenceWaitOptions = {},
  ): Promise<SequenceJob> {
    const intervalMs = normalizePollInterval(opts.intervalMs);
    const timeoutMs = normalizeWaitTimeout(opts.timeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new RequestAbortedError();
      const job = await this.getJob(jobID, { signal: opts.signal });
      if (job.status === "succeeded" || job.status === "failed") {
        return job;
      }
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), opts.signal);
    }
    throw new Error(`sequences.waitForJob(${jobID}): timed out after ${timeoutMs}ms`);
  }

  update(
    id: string,
    req: UpdateSequenceRequest,
    expectedVersion: number,
  ): Promise<Sequence> {
    return this.client.request(
      "PATCH",
      `/api/v1/voice/sequences/${encodeURIComponent(id)}`,
      {
        body: req,
        headers: { "If-Match": sequenceIfMatch(expectedVersion) },
      },
    );
  }

  delete(id: string, expectedVersion: number): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/voice/sequences/${encodeURIComponent(id)}`,
      { headers: { "If-Match": sequenceIfMatch(expectedVersion) } },
    );
  }

  /**
   * Who is (or was) inside this sequence.
   *
   * Requires read:campaigns AND read:subscribers — a token holding only one of
   * the two gets a 403, which is a scope answer rather than a fault.
   *
   * Derived from `sequence_funnel_events`, the only per-(sequence, subscriber)
   * table the platform writes. With no qualified delivery runtime nothing
   * writes it, so an empty page is the honest, expected answer today; render it
   * as "nobody has entered", never as a load failure.
   */
  participants(
    id: string,
    query: SequenceParticipantsQuery = {},
  ): Promise<SequenceParticipantsPage> {
    return this.client.request(
      "GET",
      `/api/v1/voice/sequences/${encodeURIComponent(id)}/participants${sequenceQuery(query)}`,
    );
  }

  /**
   * Per-step reach/open/click.
   *
   * Mounted behind `read:reports` AND the heavy-read limiter — a DIFFERENT
   * scope from every other sequence read, so a token that can see the topology
   * can legitimately 403 here.
   */
  funnel(id: string): Promise<SequenceFunnel> {
    return this.client.request(
      "GET",
      `/api/v1/voice/sequences/${encodeURIComponent(id)}/funnel`,
    );
  }

  /**
   * Participants idle longer than the sequence's threshold.
   *
   * The handler answers 400 — NOT an empty list — when the sequence has no
   * `stuck_after_days` configured and no `days` override is supplied. Callers
   * must render that as "detection is off", never as a failure.
   */
  stuck(id: string, days?: number): Promise<StuckParticipantsReport> {
    const query =
      typeof days === "number" && Number.isFinite(days) && days > 0
        ? `?days=${Math.trunc(days)}`
        : "";
    return this.client.request(
      "GET",
      `/api/v1/voice/sequences/${encodeURIComponent(id)}/stuck${query}`,
    );
  }
}

/**
 * Convert a confirmed body revision into the canonical strong ETag form.
 *
 * EXPORTED SO THERE IS EXACTLY ONE DEFINITION OF THIS HEADER. The Voice
 * handler requires If-Match on every sequence mutation: `parseSequenceIfMatch`
 * answers 428 without one and 400 for anything that is not one exact strong
 * ETag holding a positive integer, and `UpdateWithVersion`/`DeleteWithVersion`
 * answer 412 when the row has moved on. A client that re-implements the
 * quoting is one edit away from turning every save into a 400 on that client
 * alone — which is precisely how a 412-handling bug reaches production on one
 * surface and nowhere else.
 *
 * Throws rather than returning null: a caller that reached here with a
 * nonsensical version has a bug, and sending the request anyway would trade a
 * loud local failure for a confusing server-side one.
 */
export function sequenceIfMatch(expectedVersion: number): string {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error("Sequence expectedVersion must be a positive safe integer");
  }
  return `"${expectedVersion}"`;
}

/** Whether a value can be sent as `expectedVersion` at all. */
export function isSequenceVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Build the participants query string, omitting every default.
 *
 * `page=1` and an absent `status` are what the server already does, so sending
 * them adds bytes and makes two identical requests look different in a log.
 */
function sequenceQuery(query: SequenceParticipantsQuery): string {
  const params = new URLSearchParams();
  if (query.status) params.set("status", String(query.status));
  if (query.sort) params.set("sort", query.sort);
  if (typeof query.page === "number" && query.page > 1) {
    params.set("page", String(Math.trunc(query.page)));
  }
  if (typeof query.perPage === "number" && query.perPage > 0) {
    params.set("per_page", String(Math.trunc(query.perPage)));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function normalizePollInterval(value: number | undefined): number {
  if (value === undefined) return 2000;
  if (!Number.isFinite(value) || value <= 0) return 2000;
  return Math.min(Math.floor(value), 30_000);
}

export function sequencePositionPathSegment(position: number): string {
  if (!Number.isSafeInteger(position) || position < 1) {
    throw new Error("Sequence email position must be a positive integer");
  }
  return String(position);
}

function normalizeWaitTimeout(value: number | undefined): number {
  if (value === undefined) return 5 * 60_000;
  if (!Number.isFinite(value) || value <= 0) return 5 * 60_000;
  return Math.min(Math.floor(value), 30 * 60_000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new RequestAbortedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new RequestAbortedError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
