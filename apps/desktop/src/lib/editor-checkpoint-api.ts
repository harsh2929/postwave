/**
 * editor-checkpoint-api — the desktop half of the per-user durable draft
 * checkpoint (ECO-03), mirroring apps/api/internal/editorcheckpoint:
 *
 *   GET    /api/v1/editor/checkpoints/{entity_key}/{entity_id}
 *   PUT    /api/v1/editor/checkpoints/{entity_key}/{entity_id}
 *   DELETE /api/v1/editor/checkpoints/{entity_key}/{entity_id}
 *
 * Why this file exists: the program's bar is "close ONE CLIENT during a
 * supported task, open ANOTHER". apps/web got a checkpoint client; desktop did
 * not. Desktop is the surface where "I closed my laptop app" is literal, so a
 * web-only implementation satisfies the clause on no device at all — the second
 * device is always the one that has nothing.
 *
 * The entity vocabulary is @postwave/route-map's, exactly as in
 * lib/activity-cursor. The two halves of continuity — the cursor's REFERENCE
 * and this CONTENT — must agree on what an entity is; the server's own header
 * calls that drift out by name.
 *
 * --- what is deliberately kept from the web reference ---
 *
 *   * `found:false` is an ordinary 200 absence, NOT an error. It is the answer
 *     on every clean open, and turning it into a failure puts an error on the
 *     happy path, which is how real errors stop being noticed.
 *   * A stale save is a 409 CARRYING the current checkpoint, so the caller can
 *     show BOTH drafts. Swallowing it, or silently re-saving at the server's
 *     version, destroys the newer work the refusal exists to protect.
 *   * The two 409s are discriminated by CODE. `stale_checkpoint` means another
 *     device saved newer work; `too_many_checkpoints` means this account holds
 *     200 open drafts. Keying on the STATUS alone tells someone at the row cap
 *     that another device saved newer work, which is false.
 *   * A 4xx the draft caused is PERMANENT — an autosave loop retrying it is
 *     pure noise — while 5xx/429/offline is transient and the next tick should
 *     just try again.
 *
 * --- what is deliberately different on desktop ---
 *
 *  1. Failures arrive as an `{ error }` RESULT, not a thrown exception.
 *     `apiRequest` resolves with a discriminated union, so a straight port of
 *     web's try/catch would read every failure as a success. Same trap
 *     lib/activity-cursor documents.
 *  2. There is an `unsupported` outcome. These routes are SESSION-ONLY
 *     (routeauth manifest: `auth_methods: ["session"]`), and desktop also
 *     supports API-key auth, where the server answers 403 `session_required` /
 *     `insufficient_auth_method`. On web that cannot happen. Folding it into
 *     `refused` would tell someone "this draft broke a rule" when the truth is
 *     "this sign-in method has no per-person draft store" — a different fact
 *     with a different (and non-actionable) fix.
 *  3. Nothing here reads a response HEADER. Desktop fetches from
 *     tauri://localhost, so only CORS-exposed headers survive; the version a
 *     save must carry is in the JSON body, and keeping it there means the
 *     checkpoint cannot break on an Access-Control-Expose-Headers change.
 */

import { getEntity, isSafeResourceId } from "@postwave/route-map";

import { apiRequest } from "./api-client";

/**
 * Mirrors the server's `maxContentBytes` (editorcheckpoint.go). Checked before
 * the request because autosave is a LOOP: without it a 300 KiB draft re-uploads
 * on every debounce tick to be refused every time.
 */
export const CHECKPOINT_MAX_CONTENT_BYTES = 256 * 1024;

/**
 * Mirrors the server's `validContent` NUL rule byte-for-byte. A
 * backslash-u-0000 escape is valid JSON and is not valid in a Postgres jsonb
 * string, so the server refuses it rather than silently stripping it (which
 * would hand back a draft that differs from what was typed). The SERIALIZED
 * form is what the server measures, so it is what we check.
 */
const NUL_ESCAPE = "\\u0000";

/** Statuses that mean "try again later", not "this draft is not acceptable". */
const TRANSIENT_STATUSES = new Set([408, 425, 429]);

/**
 * Codes that mean "this client cannot hold checkpoints at all right now".
 *
 *   session_required        — the handler's own refusal for a non-session principal
 *   insufficient_auth_method— the route middleware's equivalent
 *   identity_transition /
 *   identity_changed        — a workspace switch or sign-out is in flight; the
 *                             request never left, and there is no fault to report
 */
const UNSUPPORTED_CODES = new Set([
  "session_required",
  "insufficient_auth_method",
  "identity_transition",
  "identity_changed",
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
  /** Session-only route reached without a session. Not a fault, not a draft. */
  | { status: "unsupported"; message: string }
  | { status: "unavailable"; message: string };

export type CheckpointSave<T = unknown> =
  | { status: "saved"; checkpoint: EditorCheckpoint<T> }
  /**
   * 409 `stale_checkpoint`. `current` is the checkpoint the server holds — the
   * newer work from the other device. Null only when the server could not
   * re-read it, in which case the caller still knows a conflict happened and
   * still must not pick a winner.
   */
  | { status: "stale"; current: EditorCheckpoint<T> | null; message: string }
  /** The draft broke a rule; retrying the same draft cannot succeed. */
  | { status: "refused"; code: string; message: string }
  /** This sign-in cannot hold checkpoints; retrying anything cannot succeed. */
  | { status: "unsupported"; message: string }
  /** Offline, timeout, rate limit, 5xx — the next autosave tick may work. */
  | { status: "unavailable"; message: string };

const UNREADABLE_MESSAGE =
  "The saved draft could not be read. It has been left untouched.";

const UNSUPPORTED_MESSAGE =
  "Draft checkpoints are per-person and need a signed-in session. This window is authenticated with an API key, so nothing is being checkpointed to the server.";

/** The slice of a desktop `apiRequest` result this module reads. */
interface CheckpointRequestResult<T> {
  data?: T;
  error?: {
    status?: number;
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

export type CheckpointRequester = <T>(
  path: string,
  init?: RequestInit,
) => Promise<CheckpointRequestResult<T>>;

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

/**
 * Build the resource path, or null when the reference is one this build cannot
 * address. Validated client-side (as lib/activity-cursor does) so a bad
 * reference is dropped here rather than round-tripping to the server's 400.
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
 * one the server documents. Never guesses a missing field: half a checkpoint
 * restored into an editor is worse than none, because the person cannot tell
 * which half is theirs.
 */
export function toCheckpoint<T>(raw: unknown): EditorCheckpoint<T> | null {
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

type Failure =
  | { status: "refused"; code: string; message: string }
  | { status: "unsupported"; message: string }
  | { status: "unavailable"; message: string };

/**
 * Split an `{ error }` result into "this sign-in cannot do this", "the draft is
 * not acceptable" and "the request did not land".
 *
 * A 4xx the server authored is the second: it names a rule, and repeating the
 * request cannot change the answer. Everything else — offline, timeout, 429,
 * 5xx, a transport failure with no status — is the third.
 */
function classifyFailure(error: CheckpointRequestResult<unknown>["error"]): Failure {
  const status = error?.status ?? 0;
  const code = error?.code ?? "";
  const message = error?.message?.trim()
    ? error.message.trim()
    : "The draft could not be saved.";
  if (UNSUPPORTED_CODES.has(code) || status === 401 || status === 403) {
    return { status: "unsupported", message: UNSUPPORTED_MESSAGE };
  }
  if (status >= 400 && status < 500 && !TRANSIENT_STATUSES.has(status)) {
    return { status: "refused", code: code || `http_${status}`, message };
  }
  return { status: "unavailable", message };
}

export function createEditorCheckpointClient(deps: {
  request: CheckpointRequester;
}): EditorCheckpointClient {
  const { request } = deps;

  return {
    /**
     * Read this person's checkpoint for one entity.
     *
     * `absent` is the expected answer on a clean open and carries no failure.
     * `unavailable` means we genuinely could not tell, which is NOT the same
     * thing and must never be rendered as "you have no draft".
     */
    async load<T = unknown>(
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
      let result: CheckpointRequestResult<unknown>;
      try {
        result = await request<unknown>(path, { method: "GET" });
      } catch {
        return {
          status: "unavailable",
          message: "The saved draft could not be reached.",
        };
      }
      if (result.error) {
        const failure = classifyFailure(result.error);
        return failure.status === "unsupported"
          ? failure
          : { status: "unavailable", message: failure.message };
      }
      const envelope = result.data as
        | { found?: unknown; checkpoint?: unknown }
        | undefined;
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
    async save<T = unknown>(
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
      if (
        new TextEncoder().encode(serialized).byteLength >
        CHECKPOINT_MAX_CONTENT_BYTES
      ) {
        return {
          status: "refused",
          code: "content_too_large",
          message: "A draft checkpoint is limited to 256 KiB.",
        };
      }
      if (serialized.includes(NUL_ESCAPE)) {
        return {
          status: "refused",
          code: "unsupported_content",
          message: "A draft cannot contain a \\u0000 escape.",
        };
      }

      let result: CheckpointRequestResult<unknown>;
      try {
        result = await request<unknown>(path, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, version }),
        });
      } catch {
        return {
          status: "unavailable",
          message: "The draft could not be saved.",
        };
      }
      if (result.error) {
        // 409 is TWO different facts. Only `stale_checkpoint` means another
        // device saved newer work; `too_many_checkpoints` is this account at
        // the row cap and falls through to `refused` with the server's own
        // explanation.
        if (result.error.status === 409 && result.error.code === "stale_checkpoint") {
          return {
            status: "stale",
            // parseErrorEnvelope lifts every non-framing key of the nested
            // `error` object into `details`, so the server's `current` arrives
            // there rather than at the root.
            current: toCheckpoint<T>(result.error.details?.current),
            message:
              result.error.message?.trim() ||
              "A newer draft was saved from another device.",
          };
        }
        return classifyFailure(result.error);
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
     * restore a draft that is already the saved state, which reads as a bug and
     * trains people to dismiss the prompt.
     *
     * Reports whether the server confirmed. Callers treat false as "try again
     * on the next clean open" rather than surfacing it: failing to delete a
     * draft is not something the person can act on.
     */
    async discard(entityKey: string, entityId: string): Promise<boolean> {
      const path = checkpointPath(entityKey, entityId);
      if (!path) return false;
      try {
        const result = await request<unknown>(path, { method: "DELETE" });
        return !result.error;
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

/**
 * The live client, bound to the desktop API layer.
 *
 * `apiRequest` — NOT `queueableApiRequest`. A versioned draft write must never
 * be parked in the offline outbox: replayed minutes later it would carry a
 * version the server has long since moved past, producing a guaranteed 409 with
 * no editor open to resolve it. `apiRequest` cannot queue (its result type has
 * no queued member) and `/api/v1/editor/checkpoints/` is additionally listed in
 * offline-store's ONLINE_ONLY_PATTERNS, so the guarantee survives the
 * allowlist growing.
 */
export const editorCheckpoints = createEditorCheckpointClient({
  request: <T>(path: string, init?: RequestInit) =>
    apiRequest<T>(path, init) as Promise<CheckpointRequestResult<T>>,
});
