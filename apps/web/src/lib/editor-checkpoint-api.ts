// SPDX-License-Identifier: AGPL-3.0-only
//
// Client for the per-user durable draft checkpoint (ECO-03 — task handoff and
// durable drafts). Mirrors apps/api/internal/editorcheckpoint:
//
//   GET    /api/v1/editor/checkpoints/{entity_key}/{entity_id}
//   PUT    /api/v1/editor/checkpoints/{entity_key}/{entity_id}
//   DELETE /api/v1/editor/checkpoints/{entity_key}/{entity_id}
//
// Those routes have been mounted, RLS-scoped and DB-tested with NO caller on
// any surface — web, desktop, mobile and the packages all returned zero hits
// for `editorcheckpoint` / `editor/checkpoint`. Nothing had ever written a
// checkpoint, so the "authoritative checkpoint" the program promises did not
// exist: `activity-cursor` carried the REFERENCE half of continuity ("Continue
// — <campaign>") and opened an empty form on the second device, because the
// content half had no client.
//
// The entity vocabulary is @postwave/route-map's, exactly as in
// lib/activity-cursor. The server's own header calls out that the two halves
// of continuity disagreeing about what an entity is "is precisely the drift
// that mounting them together was supposed to prevent" — so the key that names
// a checkpoint is the same key that names a cursor, not a parallel namespace.
//
// --- why this returns outcomes instead of throwing ---
//
// Three server behaviours are load-bearing and a throw would flatten all of
// them into "something went wrong":
//
//   * A MISSING draft is 200 `{found:false}`, NOT 404. That is the ordinary
//     answer on every clean open; treating it as an error would put a failure
//     on the happy path (which is how real errors stop being noticed).
//   * A STALE save is 409 CARRYING the current checkpoint. The entire point of
//     the refusal is that the client can show BOTH and let the person choose.
//     Swallowing it, or silently retrying at the server's version, destroys the
//     newer work the refusal exists to protect.
//   * A refusal the draft caused (too large, unsupported escape, row cap) is
//     permanent — retrying an autosave loop against it is pure noise — while a
//     5xx/offline failure is transient and the next tick should just try again.
//     They need different UI, so they are different outcomes.
//
// BOTH 409 codes matter. `stale_checkpoint` means another device saved newer
// work; `too_many_checkpoints` means this account is holding 200 open drafts.
// Keying the conflict UI on the STATUS alone would tell someone at the row cap
// that another device saved newer work, which is simply false.

import { getEntity, isSafeResourceId } from "@postwave/route-map";

import { api, isApiError } from "@/lib/api";

/**
 * Mirrors the server's `maxContentBytes` (editorcheckpoint.go). Checked before
 * the request because autosave is a LOOP: without it a 300 KiB draft re-uploads
 * every debounce tick to be refused every time, which on a slow connection is
 * the worst possible way to learn the draft is too big.
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
   * newer work from the other device. It is null only when the server could not
   * re-read it, in which case the caller still knows a conflict happened and
   * must not pick a winner.
   */
  | { status: "stale"; current: EditorCheckpoint<T> | null; message: string }
  /** The draft broke a rule; retrying the same draft cannot succeed. */
  | { status: "refused"; code: string; message: string }
  /** Offline, timeout, rate limit, 5xx — the next autosave tick may work. */
  | { status: "unavailable"; message: string };

const UNREADABLE_MESSAGE =
  "The saved draft could not be read. It has been left untouched.";

/**
 * Build the resource path, or null when the reference is one this build cannot
 * address. Validated client-side (as lib/activity-cursor does) so a bad
 * reference is dropped here instead of round-tripping to the server's 400.
 */
function checkpointPath(entityKey: string, entityId: string): string | null {
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

/**
 * Split a failure into "the draft is not acceptable" and "the request did not
 * land". A 4xx the server authored is the first: it names a rule and repeating
 * the request cannot change the answer. Everything else — offline, timeout,
 * 429, 5xx, a network error with no status — is the second.
 */
function refusalOrOutage(
  err: unknown,
): { status: "refused"; code: string; message: string } | { status: "unavailable"; message: string } {
  if (!isApiError(err)) {
    return {
      status: "unavailable",
      message:
        err instanceof Error && err.message
          ? err.message
          : "The draft could not be saved.",
    };
  }
  if (err.status >= 400 && err.status < 500 && !TRANSIENT_STATUSES.has(err.status)) {
    return { status: "refused", code: err.code, message: err.message };
  }
  return { status: "unavailable", message: err.message };
}

/**
 * Read this person's checkpoint for one entity.
 *
 * `absent` is the expected answer on a clean open and carries no failure;
 * `unavailable` means we genuinely could not tell, which is NOT the same thing
 * and must not be rendered as "you have no draft".
 */
export async function loadCheckpoint<T = unknown>(
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
  let body: unknown;
  try {
    body = await api.get<unknown>(path);
  } catch (err) {
    const outcome = refusalOrOutage(err);
    return { status: "unavailable", message: outcome.message };
  }
  const envelope = body as { found?: unknown; checkpoint?: unknown } | undefined;
  if (!envelope || envelope.found !== true) return { status: "absent" };
  const checkpoint = toCheckpoint<T>(envelope.checkpoint);
  if (!checkpoint) return { status: "unavailable", message: UNREADABLE_MESSAGE };
  return { status: "found", checkpoint };
}

/**
 * Write this person's checkpoint, carrying the version it was built on.
 *
 * `version` 0 means "I hold no checkpoint" and succeeds only when the server
 * holds none either — so two devices that both start fresh cannot silently
 * clobber each other on the first save.
 */
export async function saveCheckpoint<T = unknown>(
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
  if (new TextEncoder().encode(serialized).byteLength > CHECKPOINT_MAX_CONTENT_BYTES) {
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

  try {
    // requireOnline: a versioned draft write must never be parked in the
    // offline outbox. Replayed minutes later it would carry a version the
    // server has long since moved past — a guaranteed 409 that arrives with no
    // editor open to resolve it. The checkpoint route is not in the outbox
    // allowlist today; this keeps that true if the allowlist ever grows.
    const raw = await api.put<unknown>(
      path,
      { content, version },
      { requireOnline: true },
    );
    const checkpoint = toCheckpoint<T>(raw);
    if (!checkpoint) {
      return { status: "unavailable", message: UNREADABLE_MESSAGE };
    }
    return { status: "saved", checkpoint };
  } catch (err) {
    // 409 is TWO different facts. Only `stale_checkpoint` means another device
    // saved newer work; `too_many_checkpoints` is this account at the row cap
    // and falls through to `refused` with the server's own explanation.
    if (isApiError(err) && err.status === 409 && err.code === "stale_checkpoint") {
      const body = err.body as
        | { error?: { current?: unknown } }
        | undefined;
      return {
        status: "stale",
        current: toCheckpoint<T>(body?.error?.current),
        message: err.message,
      };
    }
    return refusalOrOutage(err);
  }
}

/**
 * Drop this person's checkpoint. Called when the edit is SAVED or explicitly
 * abandoned — leaving it behind makes the next open offer to restore a draft
 * that is already the saved state, which reads as a bug and trains people to
 * dismiss the prompt.
 *
 * Reports whether the server confirmed. Callers treat a false as "try again on
 * the next clean open" rather than surfacing it: failing to delete a draft is
 * not something the person can act on.
 */
export async function discardCheckpoint(
  entityKey: string,
  entityId: string,
): Promise<boolean> {
  const path = checkpointPath(entityKey, entityId);
  if (!path) return false;
  try {
    await api.delete(path);
    return true;
  } catch {
    return false;
  }
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
