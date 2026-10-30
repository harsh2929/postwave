/**
 * api/editorCheckpoint.ts — the mobile half of the per-user durable draft
 * checkpoint (ECO-03).
 *
 *   GET    /api/v1/editor/checkpoints/{entity_key}/{entity_id}
 *   PUT    /api/v1/editor/checkpoints/{entity_key}/{entity_id}
 *   DELETE /api/v1/editor/checkpoints/{entity_key}/{entity_id}
 *
 * `api/activityCursor.ts` is the REFERENCE half of continuity — a bare
 * (entity_key, entity_id) that lets a second device offer "Continue —
 * Campaign". This is the CONTENT half, and until now it had no client on this
 * surface at all. The server package's own header names the exact scenario:
 * "open the campaign on your phone and the half-written subject line from your
 * laptop is not there." The phone is the device you pick up second, so mobile
 * is the surface that feature was written for.
 *
 * Split from hooks/useEditorCheckpoint.ts on purpose, exactly as the cursor is:
 * this module must stay importable in the node vitest environment, so the
 * rules worth testing without a simulator — which references are addressable,
 * what a 409 actually means, what is permanent and what is worth retrying —
 * are tested here, and the React/AppState lifecycle lives next door.
 *
 * --- why this returns outcomes instead of throwing ---
 *
 * Ported verbatim in SPIRIT from apps/web/src/lib/editor-checkpoint-api.ts.
 * Three server behaviours are load-bearing and collapsing any of them into
 * "something went wrong" destroys the feature:
 *
 *   * A MISSING draft is 200 `{found:false}`, NOT 404. That is the ordinary
 *     answer on every clean open; treating it as an error would put a failure
 *     on the happy path, which is how real errors stop being noticed.
 *   * A STALE save is 409 CARRYING the current checkpoint. The whole point of
 *     the refusal is that the client can show BOTH and let the person choose.
 *     Swallowing it, or silently retrying at the server's version, destroys the
 *     newer work the refusal exists to protect.
 *   * A refusal the DRAFT caused (too large, unsupported escape, row cap) is
 *     permanent — retrying an autosave loop against it is pure noise — while a
 *     5xx/offline failure is transient and the next tick should just try again.
 *
 * BOTH 409 codes matter. `stale_checkpoint` means another device saved newer
 * work; `too_many_checkpoints` means this account is holding 200 open drafts.
 * Keying the conflict UI on the STATUS alone would tell someone at the row cap
 * that another device saved newer work, which is simply false.
 *
 * --- what mobile adds, and why ---
 *
 * `unsupported` is a fourth save outcome that web does not need. The web app is
 * session-only; this app also runs on an API key, and the route is deliberately
 * per-person (the handler answers 403 `session_required` for a shared key,
 * because every holder of one key would read and overwrite each other's
 * unfinished work). That is the API behaving correctly, not a draft breaking a
 * rule, so it must neither raise the "this draft is not being checkpointed"
 * banner nor keep the autosave loop hammering a 403 every two seconds. The
 * cursor module makes the same distinction for the same reason.
 */
import { getEntity, isSafeResourceId } from "@postwave/route-map";

import { utf8ByteLength } from "@/lib/utf8";

/**
 * Mirrors the server's `maxContentBytes` (editorcheckpoint.go). Checked before
 * the request because autosave is a LOOP: without it an oversized draft
 * re-uploads every debounce tick to be refused every time, which on a phone
 * connection is the worst possible way to learn the draft is too big.
 */
export const CHECKPOINT_MAX_CONTENT_BYTES = 256 * 1024;

/**
 * Mirrors the server's `validContent` NUL rule byte-for-byte. A backslash-u-0000
 * escape is valid JSON and is not valid in a Postgres jsonb string, so the
 * server refuses it with 422 rather than silently stripping it (which would
 * hand back a draft that differs from what was typed). We check the SERIALIZED
 * form, which is what the server measures.
 */
const NUL_ESCAPE = "\\u0000";

/** Statuses that mean "try again later", not "this draft is not acceptable". */
const TRANSIENT_STATUSES = new Set([408, 425, 429]);

/**
 * Statuses that mean "this surface cannot hold a draft right now" — signed
 * out, or authenticated with a shared API key the session-only route refuses.
 * Neither is a property of the draft and neither is worth retrying, so they
 * are their own outcome rather than being flattened into a refusal (which
 * would show an alarming banner) or an outage (which would retry forever).
 */
const UNSUPPORTED_STATUSES = new Set([401, 403]);

/** Transport-level codes that mean "not now" rather than "broken". */
const TRANSIENT_CODES = new Set([
  "offline",
  "network_error",
  "timeout",
  "identity_transition",
  "exhausted",
]);

export interface EditorCheckpoint<T = unknown> {
  entity_key: string;
  entity_id: string;
  content: T;
  /** Optimistic version. A save must carry the version it was built on. */
  version: number;
  updated_at: string;
}

export type CheckpointLoad<T = unknown> =
  | { status: "found"; checkpoint: EditorCheckpoint<T> }
  /** 200 `{found:false}` — the ordinary "no draft" answer, not an error. */
  | { status: "absent" }
  | { status: "unavailable"; message: string };

export type CheckpointSave<T = unknown> =
  | { status: "saved"; checkpoint: EditorCheckpoint<T> }
  /**
   * 409 `stale_checkpoint`. `current` is the checkpoint the server holds — the
   * newer work from the other device. It is null only when the server could
   * not re-read it, in which case the caller still knows a conflict happened
   * and must not pick a winner.
   */
  | { status: "stale"; current: EditorCheckpoint<T> | null; message: string }
  /** The draft broke a rule; retrying the same draft cannot succeed. */
  | { status: "refused"; code: string; message: string }
  /** No signed-in person to own a draft. Silent, and not worth retrying. */
  | { status: "unsupported"; code: string }
  /** Offline, timeout, rate limit, 5xx — the next autosave tick may work. */
  | { status: "unavailable"; message: string };

const UNREADABLE_MESSAGE =
  "The saved draft could not be read. It has been left untouched.";

/** The slice of the mobile result envelope (api/request.ts) this module reads. */
export interface CheckpointResult<T> {
  data: T | null;
  error: {
    status?: number;
    code?: string;
    message?: string;
    payload?: unknown;
  } | null;
}

export type CheckpointRequester = <T>(
  method: string,
  path: string,
  body?: unknown,
) => Promise<CheckpointResult<T>>;

/**
 * Build the resource path, or null when the reference is one this build cannot
 * address. Validated client-side (as api/activityCursor does) so a bad
 * reference is dropped here instead of round-tripping to the server's 400.
 */
export function checkpointPath(
  entityKey: string,
  entityId: string,
): string | null {
  if (!getEntity(entityKey) || !isSafeResourceId(entityId)) return null;
  return `/api/v1/editor/checkpoints/${encodeURIComponent(
    entityKey,
  )}/${encodeURIComponent(entityId)}`;
}

/**
 * Narrow a server payload to a checkpoint, or null when the shape is not the
 * one the server documents. Never guesses a missing field: a half-read
 * checkpoint restored into an editor is worse than no checkpoint, because the
 * person cannot tell which half is theirs.
 */
function toCheckpoint<T>(raw: unknown): EditorCheckpoint<T> | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.entity_key !== "string" || !record.entity_key) return null;
  if (typeof record.entity_id !== "string" || !record.entity_id) return null;
  if (typeof record.updated_at !== "string" || !record.updated_at) return null;
  if (typeof record.version !== "number" || !Number.isFinite(record.version)) {
    return null;
  }
  if (!("content" in record)) return null;
  return {
    entity_key: record.entity_key,
    entity_id: record.entity_id,
    content: record.content as T,
    version: record.version,
    updated_at: record.updated_at,
  };
}

type SaveFailure<T> = Extract<
  CheckpointSave<T>,
  { status: "refused" | "unsupported" | "unavailable" }
>;

/**
 * Split a failure into "there is nobody to own a draft", "the draft is not
 * acceptable" and "the request did not land".
 *
 * A 4xx the server authored is the second: it names a rule and repeating the
 * request cannot change the answer. Everything else — offline, timeout, 429,
 * 5xx, a transport error the SDK reports as status 0 — is the third.
 */
function classifyFailure<T>(
  error: NonNullable<CheckpointResult<unknown>["error"]>,
): SaveFailure<T> {
  const status = error.status ?? 0;
  const code = error.code ?? "";
  const message = error.message || "The draft could not be saved.";
  if (UNSUPPORTED_STATUSES.has(status)) {
    return { status: "unsupported", code: code || `http_${status}` };
  }
  if (TRANSIENT_CODES.has(code)) return { status: "unavailable", message };
  if (status >= 400 && status < 500 && !TRANSIENT_STATUSES.has(status)) {
    return { status: "refused", code: code || `http_${status}`, message };
  }
  return { status: "unavailable", message };
}

export interface EditorCheckpointClient {
  load<T = unknown>(
    entityKey: string,
    entityId: string,
  ): Promise<CheckpointLoad<T>>;
  save<T = unknown>(
    entityKey: string,
    entityId: string,
    content: T,
    version: number,
  ): Promise<CheckpointSave<T>>;
  discard(entityKey: string, entityId: string): Promise<boolean>;
}

export function createEditorCheckpointClient(deps: {
  request: CheckpointRequester;
  /**
   * Synchronous reachability read (lib/connectivity.isProbablyOnline).
   *
   * A VERSIONED draft write must never be parked for offline replay: replayed
   * minutes later it would carry a version the server has long since moved
   * past — a guaranteed 409 that arrives with no editor open to resolve it.
   * On this app the outbox is opt-in (a `useMutation` carrying
   * `offlineSafeMutationMeta`, plus a route the lib/offlineQueueSafety
   * allowlist admits) and this client is neither, so a checkpoint write cannot
   * be queued today. This closes the remaining hole: with TanStack's default
   * `networkMode: "online"`, ANY write issued while offline is a write the
   * runtime may hold and resume later. Refusing at the door means the write
   * either happens now or does not happen at all.
   */
  isOnline?: () => boolean;
}): EditorCheckpointClient {
  const { request, isOnline } = deps;

  return {
    /**
     * Read this person's checkpoint for one entity.
     *
     * `absent` is the expected answer on a clean open and carries no failure;
     * `unavailable` means we genuinely could not tell, which is NOT the same
     * thing and must not be rendered as "you have no draft".
     */
    async load<T>(
      entityKey: string,
      entityId: string,
    ): Promise<CheckpointLoad<T>> {
      const path = checkpointPath(entityKey, entityId);
      if (!path) {
        return {
          status: "unavailable",
          message: "This item cannot hold a draft checkpoint.",
        };
      }
      let result: CheckpointResult<unknown>;
      try {
        result = await request<unknown>("GET", path);
      } catch (err) {
        return {
          status: "unavailable",
          message:
            err instanceof Error && err.message
              ? err.message
              : "The draft could not be read.",
        };
      }
      if (result.error) {
        const outcome = classifyFailure<T>(result.error);
        // Signed out, or on a shared API key: there is no per-person draft to
        // read and there never will be on this credential. Reporting an
        // absence is the truth from the caller's point of view, and it keeps
        // the resume banner off a screen that can never offer anything.
        if (outcome.status === "unsupported") return { status: "absent" };
        return { status: "unavailable", message: outcome.message };
      }
      const envelope = result.data as
        | { found?: unknown; checkpoint?: unknown }
        | null;
      if (!envelope || envelope.found !== true) return { status: "absent" };
      const checkpoint = toCheckpoint<T>(envelope.checkpoint);
      if (!checkpoint) {
        return { status: "unavailable", message: UNREADABLE_MESSAGE };
      }
      return { status: "found", checkpoint };
    },

    /**
     * Write this person's checkpoint, carrying the version it was built on.
     *
     * `version` 0 means "I hold no checkpoint" and succeeds only when the
     * server holds none either — so two devices that both start fresh cannot
     * silently clobber each other on the first save.
     */
    async save<T>(
      entityKey: string,
      entityId: string,
      content: T,
      version: number,
    ): Promise<CheckpointSave<T>> {
      const path = checkpointPath(entityKey, entityId);
      if (!path) {
        return {
          status: "refused",
          code: "invalid_entity",
          message: "This item cannot hold a draft checkpoint.",
        };
      }
      const serialized = JSON.stringify(content);
      if (serialized === undefined) {
        // The server answers 422 `missing_content`: "use DELETE to discard".
        return {
          status: "refused",
          code: "missing_content",
          message: "There is nothing to checkpoint.",
        };
      }
      if (utf8ByteLength(serialized) > CHECKPOINT_MAX_CONTENT_BYTES) {
        return {
          status: "refused",
          code: "content_too_large",
          message: "a draft checkpoint is limited to 256 KiB",
        };
      }
      if (serialized.includes(NUL_ESCAPE)) {
        return {
          status: "refused",
          code: "unsupported_content",
          message: "a draft cannot contain a \\u0000 escape",
        };
      }
      if (isOnline && !isOnline()) {
        // Not an error the person can act on, and deliberately NOT queued.
        return {
          status: "unavailable",
          message: "This device is offline; the draft was not sent.",
        };
      }

      let result: CheckpointResult<unknown>;
      try {
        result = await request<unknown>("PUT", path, { content, version });
      } catch (err) {
        return {
          status: "unavailable",
          message:
            err instanceof Error && err.message
              ? err.message
              : "The draft could not be saved.",
        };
      }
      if (result.error) {
        // 409 is TWO different facts. Only `stale_checkpoint` means another
        // device saved newer work; `too_many_checkpoints` is this account at
        // the row cap and falls through to `refused` with the server's own
        // explanation.
        if (result.error.status === 409 && result.error.code === "stale_checkpoint") {
          const body = result.error.payload as
            | { error?: { current?: unknown } }
            | undefined;
          return {
            status: "stale",
            current: toCheckpoint<T>(body?.error?.current),
            message: result.error.message || "a newer draft was saved from another device",
          };
        }
        return classifyFailure<T>(result.error);
      }
      const checkpoint = toCheckpoint<T>(result.data);
      if (!checkpoint) {
        return { status: "unavailable", message: UNREADABLE_MESSAGE };
      }
      return { status: "saved", checkpoint };
    },

    /**
     * Drop this person's checkpoint. Called when the edit is SAVED or
     * explicitly abandoned — leaving it behind makes the next open offer to
     * restore a draft that is already the saved state, which reads as a bug
     * and trains people to dismiss the prompt.
     *
     * Reports whether the server confirmed. Callers treat a false as "try
     * again on the next clean open" rather than surfacing it: failing to
     * delete a draft is not something the person can act on.
     */
    async discard(entityKey: string, entityId: string): Promise<boolean> {
      const path = checkpointPath(entityKey, entityId);
      if (!path) return false;
      try {
        const result = await request<unknown>("DELETE", path);
        return result.error === null;
      } catch {
        return false;
      }
    },
  };
}

/**
 * True when `checkpoint` holds work the saved record does not — the only case
 * in which resuming is an offer worth making.
 *
 * A checkpoint older than the record cannot be newer work, and offering it
 * would invite someone to overwrite the saved version with a draft that
 * predates it. Unparseable timestamps resolve to "do not offer": a resume
 * prompt shown on a guess is worse than none.
 */
export function isNewerThanRecord(
  checkpoint: Pick<EditorCheckpoint, "updated_at">,
  recordUpdatedAt: string | undefined,
): boolean {
  const draftAt = Date.parse(checkpoint.updated_at);
  if (Number.isNaN(draftAt)) return false;
  if (!recordUpdatedAt) return false;
  const savedAt = Date.parse(recordUpdatedAt);
  if (Number.isNaN(savedAt)) return false;
  return draftAt > savedAt;
}
