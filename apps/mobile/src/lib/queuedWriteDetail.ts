/**
 * lib/queuedWriteDetail.ts — a queued write, read back as the REQUEST it is.
 *
 * lib/offlineMutationQueue.ts answers "what is waiting" (label, status,
 * expiry) and deliberately exposes no body: the banner and the queue section
 * only need to count. Conflict resolution and in-place editing (P2.56 / the
 * P3 outbox-depth row) need the other half — the verb, the path and the body
 * the executor will actually send — and they need to put an EDITED body back
 * so the next replay carries it.
 *
 * Both halves read the same TanStack mutation cache. Nothing here is a second
 * queue: a detail is derived from the mutation on demand, and a re-issue
 * builds a new mutation through `MutationCache.build`, which applies the SAME
 * defaults (`registerOfflineMutationDefaults`) a screen's useMutation would —
 * so the replay runs the same executor, the same replay-time safety checks and
 * the same failure journalling as the original. Desktop does the equivalent
 * by rewriting the stored item (`updateOfflineMutation`); TanStack mutations
 * are immutable once built, so mobile replaces the mutation instead.
 *
 * Pure: no react-native, no SDK. The impure inputs — the client, the
 * `offlineSafe` meta and a freshly minted auth scope — are parameters, so the
 * whole re-issue path is exercised against a real QueryClient in node.
 */
import type { Mutation, QueryClient } from "@tanstack/react-query";

import {
  OFFLINE_MUTATION_KEYS,
  type OfflineMutationAuthScope,
} from "./offlineMutationContract";
import {
  listOfflineMutationQueue,
  type OfflineMutationStatus,
} from "./offlineMutationQueue";

export type QueuedWriteKind =
  | "entity_write"
  | "campaign_update"
  | "sequence_create"
  | "sequence_save";

export type QueuedWriteMethod = "POST" | "PATCH" | "PUT";

export interface QueuedWriteFailure {
  /** HTTP status the executor saw, or 0 when the error carried none. */
  status: number;
  /** The server's machine-readable code, when the envelope had one. */
  code: string | null;
  message: string;
}

export interface QueuedWriteDetail {
  mutationId: number;
  operationId: string;
  kind: QueuedWriteKind;
  label: string;
  status: OfflineMutationStatus;
  method: QueuedWriteMethod;
  path: string;
  /** The body the executor sends; undefined when the write carries none. */
  body: unknown;
  failure: QueuedWriteFailure | null;
  /** Whether this surface can rebuild the write from an edited body. */
  editable: boolean;
  /** The persisted variables, verbatim — the base for a rebuild. */
  variables: Record<string, unknown>;
}

/** The four campaign fields the authoring sheet can queue (lib/offlineMutations). */
export const CAMPAIGN_UPDATE_FIELDS = [
  "subject",
  "preview_text",
  "from_name",
  "reply_to",
] as const;

const SEQUENCE_NAME_MAX_CHARS = 200;
const VOICE_SEQUENCES_PATH = "/api/v1/voice/sequences";

type Rebuilt = Record<string, unknown>;

export type RebuildResult =
  | { ok: true; variables: Rebuilt }
  | { ok: false; error: string };

/** Every queued write for this identity, with its request shape. */
export function listQueuedWriteDetails(
  client: QueryClient,
  scope: OfflineMutationAuthScope,
  now = Date.now(),
): QueuedWriteDetail[] {
  const byId = new Map(
    listOfflineMutationQueue(client, scope, now).map((item) => [
      item.mutationId,
      item,
    ]),
  );
  return client
    .getMutationCache()
    .getAll()
    .flatMap((mutation) => {
      const item = byId.get(mutation.mutationId);
      if (!item) return [];
      const kind = kindForKey(mutation.options.mutationKey);
      const variables = asRecord(mutation.state.variables);
      if (!kind || !variables) return [];
      const request = requestFor(kind, variables);
      if (!request) return [];
      return [
        {
          mutationId: item.mutationId,
          operationId: item.operationId,
          kind,
          label: item.label,
          status: item.status,
          method: request.method,
          path: request.path,
          body: request.body,
          failure: failureFor(mutation),
          editable: kind !== "sequence_save",
          variables,
        },
      ];
    });
}

/** One queued write by its operation id — the key the failure journal shares. */
export function findQueuedWriteDetail(
  client: QueryClient,
  scope: OfflineMutationAuthScope,
  operationId: string,
  now = Date.now(),
): QueuedWriteDetail | null {
  return (
    listQueuedWriteDetails(client, scope, now).find(
      (detail) => detail.operationId === operationId,
    ) ?? null
  );
}

/**
 * The variables a replacement mutation should carry for an edited body.
 *
 * The operation id is PRESERVED — it is the server's Idempotency-Key, and a
 * retry that changed it could double-apply against an earlier attempt that
 * actually landed. The auth scope is the FRESH one the caller minted: the
 * person is present and choosing to retry now, so the two-hour TTL restarts.
 */
export function rebuildQueuedVariables(
  detail: QueuedWriteDetail,
  body: unknown,
  auth: OfflineMutationAuthScope,
): RebuildResult {
  switch (detail.kind) {
    case "entity_write": {
      if (body !== undefined && !asRecord(body)) {
        return { ok: false, error: "The body must be a JSON object." };
      }
      const { body: _dropped, ...rest } = detail.variables;
      void _dropped;
      return {
        ok: true,
        variables: {
          ...rest,
          auth,
          queuedAt: new Date(auth.queuedAt).toISOString(),
          ...(body === undefined ? {} : { body }),
        },
      };
    }
    case "campaign_update": {
      const fields = asRecord(body);
      if (!fields) {
        return { ok: false, error: "A campaign edit needs at least one field." };
      }
      const keys = Object.keys(fields);
      if (keys.length === 0) {
        return { ok: false, error: "A campaign edit needs at least one field." };
      }
      const allowed = new Set<string>(CAMPAIGN_UPDATE_FIELDS);
      for (const key of keys) {
        if (!allowed.has(key)) {
          return {
            ok: false,
            error: `"${key}" is not a field this phone can queue for a campaign. Only ${CAMPAIGN_UPDATE_FIELDS.join(", ")} replay from here.`,
          };
        }
        if (typeof fields[key] !== "string") {
          return { ok: false, error: `"${key}" must be text.` };
        }
      }
      const subject =
        typeof fields.subject === "string"
          ? fields.subject
          : typeof detail.variables.subject === "string"
            ? detail.variables.subject
            : "";
      return {
        ok: true,
        variables: {
          auth,
          operationId: detail.operationId,
          id: detail.variables.id,
          subject,
          fields,
        },
      };
    }
    case "sequence_create": {
      const record = asRecord(body);
      const name = record && typeof record.name === "string" ? record.name.trim() : "";
      if (!name) return { ok: false, error: "A sequence needs a name." };
      if (name.length > SEQUENCE_NAME_MAX_CHARS) {
        return {
          ok: false,
          error: `Keep the name under ${SEQUENCE_NAME_MAX_CHARS} characters.`,
        };
      }
      return {
        ok: true,
        variables: { auth, operationId: detail.operationId, name },
      };
    }
    case "sequence_save":
      return {
        ok: false,
        error:
          "Sequence steps are edited in the sequence builder, not here. Open the sequence to re-apply this change.",
      };
  }
}

export interface ReissuedWrite {
  mutationId: number;
  /** Resolves once the replacement has actually run — possibly much later, after a reconnect. */
  settled: Promise<"sent" | "failed">;
}

/**
 * Replace a queued write with one carrying `variables`.
 *
 * The old mutation is removed FIRST so the queue never shows two rows for one
 * operation id. `MutationCache.build` merges the defaults registered for the
 * key (executor, journalling, serial scope) exactly as useMutation does, and
 * `execute` honours the client's `networkMode`: offline, the replacement
 * pauses as a queued row and is persisted like any other; online, it runs now.
 */
export function reissueQueuedWrite(
  client: QueryClient,
  detail: QueuedWriteDetail,
  variables: Rebuilt,
  meta: Record<string, unknown>,
): ReissuedWrite {
  const cache = client.getMutationCache();
  const previous = cache
    .getAll()
    .find((mutation) => mutation.mutationId === detail.mutationId);
  if (previous) cache.remove(previous);
  const mutation = cache.build(client, {
    mutationKey: [...keyForKind(detail.kind)],
    meta,
  });
  const settled = mutation.execute(variables).then(
    () => "sent" as const,
    () => "failed" as const,
  );
  return { mutationId: mutation.mutationId, settled };
}

/**
 * Drop a queued or failed write. A write that is ON THE WIRE right now is
 * left alone — removing it from the cache would not stop the request, only
 * hide its outcome.
 */
export function discardQueuedWrite(
  client: QueryClient,
  detail: Pick<QueuedWriteDetail, "mutationId" | "status">,
): boolean {
  if (detail.status === "syncing") return false;
  const cache = client.getMutationCache();
  const target = cache
    .getAll()
    .find((mutation) => mutation.mutationId === detail.mutationId);
  if (!target) return false;
  cache.remove(target);
  return true;
}

function requestFor(
  kind: QueuedWriteKind,
  vars: Record<string, unknown>,
): { method: QueuedWriteMethod; path: string; body: unknown } | null {
  switch (kind) {
    case "entity_write": {
      const method = vars.method;
      if (
        (method !== "POST" && method !== "PATCH" && method !== "PUT") ||
        typeof vars.path !== "string"
      ) {
        return null;
      }
      return { method, path: vars.path, body: vars.body };
    }
    case "campaign_update": {
      if (typeof vars.id !== "string") return null;
      const fields = asRecord(vars.fields);
      // Mirrors executeCampaignUpdate: the diff wins when present; the bare
      // subject is the whole body for records queued by an older build.
      const body =
        fields && Object.keys(fields).length > 0
          ? fields
          : { subject: vars.subject };
      return {
        method: "PATCH",
        path: `/api/v1/campaigns/${encodeURIComponent(vars.id)}`,
        body,
      };
    }
    case "sequence_create":
      return {
        method: "POST",
        path: VOICE_SEQUENCES_PATH,
        body: { name: vars.name },
      };
    case "sequence_save": {
      if (typeof vars.id !== "string") return null;
      return {
        method: "PATCH",
        path: `${VOICE_SEQUENCES_PATH}/${encodeURIComponent(vars.id)}`,
        body: { steps: vars.steps },
      };
    }
  }
}

function failureFor(mutation: Mutation): QueuedWriteFailure | null {
  if (mutation.state.status !== "error") return null;
  const error: unknown = mutation.state.error;
  const record = asRecord(error) ?? {};
  const status = typeof record.status === "number" ? record.status : 0;
  const code =
    typeof record.code === "string" && record.code.trim() ? record.code : null;
  const message =
    error instanceof Error
      ? error.message
      : typeof record.message === "string"
        ? record.message
        : "";
  return { status, code, message };
}

function keyForKind(kind: QueuedWriteKind): readonly string[] {
  switch (kind) {
    case "entity_write":
      return OFFLINE_MUTATION_KEYS.entityWrite;
    case "campaign_update":
      return OFFLINE_MUTATION_KEYS.campaignUpdate;
    case "sequence_create":
      return OFFLINE_MUTATION_KEYS.sequenceCreate;
    case "sequence_save":
      return OFFLINE_MUTATION_KEYS.sequenceSave;
  }
}

function kindForKey(key: readonly unknown[] | undefined): QueuedWriteKind | null {
  const kinds: QueuedWriteKind[] = [
    "entity_write",
    "campaign_update",
    "sequence_create",
    "sequence_save",
  ];
  for (const kind of kinds) {
    const expected = keyForKind(kind);
    if (
      key?.length === expected.length &&
      expected.every((part, index) => key[index] === part)
    ) {
      return kind;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
