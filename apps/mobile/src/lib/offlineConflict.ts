/**
 * lib/offlineConflict.ts — resolving a queued write the server refused (P2.56).
 *
 * Desktop's ConflictModal offers "keep mine" by re-issuing the write with
 * `If-Match: *`. That mechanism does NOT transfer to this server: the
 * allowlisted PATCHes that check a precondition refuse the wildcard outright
 * with 412 (campaigns/handlers.go, forms/handlers.go — "silently weakening a
 * caller's stated intent is worse than rejecting"). The routes that
 * demand an EXACT strong token and answer 428 without one (tags, subscribers)
 * are online-only in lib/offlineQueueSafety; the token-required verdict below
 * remains for such records persisted by another build. Mobile's queued writes
 * carry no precondition at all, so "keep mine" on a phone means something
 * simpler and honest: re-issue the same unconditional write, which the server
 * applies last-writer-wins — exactly as the original would have.
 *
 * What that leaves is a VERDICT per refusal, read off the status and the
 * server's own error code, because the remedies differ:
 *
 *   - stale (409/412 with no better code): the server copy moved. Show the
 *     fields, let the person keep theirs, take the server's, or mix per field.
 *   - needs-edit (slug_taken, name_taken …): retrying verbatim fails the same
 *     way; only an edited body can land.
 *   - locked (campaign_dispatching): the record can no longer be changed from
 *     ANY device. Keep-server is the only outcome.
 *   - reload-required (sequence save): the whole step list was authored
 *     against an older revision; re-applying it blind is the silent overwrite
 *     the version check exists to prevent (lib/offlineMutationFailures.ts).
 *   - token-required (428): the route wants the record's current version
 *     token, which the queue never carried. The record's own screen sends it.
 *
 * Pure. Field comparison is scoped to MINE's keys on purpose — desktop lists
 * the union, which on a phone would surface every server column of a
 * campaign; the person queued four fields and those four are the decision.
 */
import { mobilePath } from "@postwave/route-map";

import type { OfflineMutationFailure } from "./offlineMutationFailures";
import type { QueuedWriteDetail, QueuedWriteKind } from "./queuedWriteDetail";

/**
 * The journal's safe copy for a 409/412 and for a sequence reload
 * (lib/offlineMutationFailures.ts safeMessage). DUPLICATED AS LITERALS ON
 * PURPOSE — the journal module does not export them, and importing it here
 * would pull the vault into every consumer of a pure predicate. Both are
 * pinned against the journal's actual output in lib/offlineConflict.test.ts.
 */
const CONFLICT_MESSAGE =
  "A newer server version conflicts with this queued change. Open the record to load the latest version before retrying.";
const SEQUENCE_RELOAD_MESSAGE =
  "This sequence changed elsewhere. Open the sequence to load the latest version, then re-apply this change.";
const SEQUENCE_RELOAD_CODE = "sequence_save_requires_reload";

/** Server codes whose remedy is a DIFFERENT value, never a retry. */
const NAME_CONFLICT_CODES = new Set([
  "slug_taken",
  "public_slug_taken",
  "name_taken",
  "tag_taken",
]);

const LOCKED_CODES = new Set(["campaign_dispatching", "campaign_not_draft"]);

export type ConflictVerdictKind =
  | "stale"
  | "needs-edit"
  | "locked"
  | "reload-required"
  | "token-required";

export interface ConflictVerdict {
  kind: ConflictVerdictKind;
  canKeepMine: boolean;
  canEdit: boolean;
  headline: string;
  detail: string;
}

export interface ConflictVerdictInput {
  status: number;
  code: string | null;
  kind: QueuedWriteKind;
  /** The server's own sentence, shown verbatim when the code is structured. */
  serverMessage?: string;
}

export function conflictVerdict(input: ConflictVerdictInput): ConflictVerdict {
  if (input.kind === "sequence_save" || input.code === SEQUENCE_RELOAD_CODE) {
    return {
      kind: "reload-required",
      canKeepMine: false,
      canEdit: false,
      headline: "Reload the sequence first",
      detail: SEQUENCE_RELOAD_MESSAGE,
    };
  }
  if (input.code && LOCKED_CODES.has(input.code)) {
    return {
      kind: "locked",
      canKeepMine: false,
      canEdit: false,
      headline: "This campaign can no longer be changed",
      detail:
        serverSentence(input) ??
        "It has started sending, so its content is fixed on every device. Duplicate it to send a revised version.",
    };
  }
  if (input.code && NAME_CONFLICT_CODES.has(input.code)) {
    return {
      kind: "needs-edit",
      canKeepMine: false,
      canEdit: true,
      headline: "The server refused this value",
      detail:
        serverSentence(input) ??
        "Something with the same name or address already exists. Edit the change before retrying — sending it again as-is fails the same way.",
    };
  }
  if (input.status === 428) {
    return {
      kind: "token-required",
      canKeepMine: false,
      canEdit: false,
      headline: "This record needs its latest version",
      detail:
        "The server requires the record's current version token for this write, and a queued change never carries one. Open the record and make the change there.",
    };
  }
  return {
    kind: "stale",
    canKeepMine: true,
    canEdit: true,
    headline: "The server copy changed first",
    detail:
      "Compare the fields below. Keep the server's values, keep yours, or mix them field by field — whatever you send replaces the server's copy of those fields.",
  };
}

function serverSentence(input: ConflictVerdictInput): string | null {
  const text = input.serverMessage?.trim() ?? "";
  return text ? text : null;
}

/** 409 / 412 / 428 are the three answers that mean "the server holds a different truth". */
export function isConflictStatus(status: number): boolean {
  return status === 409 || status === 412 || status === 428;
}

/** A failed queued write whose remedy is the conflict sheet, from its live error. */
export function isConflictFailure(failure: {
  status: number;
  code: string | null;
}): boolean {
  return isConflictStatus(failure.status) || failure.code === SEQUENCE_RELOAD_CODE;
}

/**
 * A journal row that recorded a conflict. The journal keeps only its own safe
 * copy, so the copy IS the discriminator; the test pins it against the module
 * that writes it.
 */
export function isConflictJournalRow(
  row: Pick<OfflineMutationFailure, "message">,
): boolean {
  return row.message === CONFLICT_MESSAGE || row.message === SEQUENCE_RELOAD_MESSAGE;
}

/** The operation id the banner should hand the diagnostics screen, if any. */
export function firstConflictOperationId(
  failures: readonly Pick<OfflineMutationFailure, "message" | "operationId">[],
): string | null {
  return failures.find(isConflictJournalRow)?.operationId ?? null;
}

/**
 * Diagnostics, asked to open the resolver for one operation on arrival. The
 * object form is what expo-router's typed routes accept; the screen reads
 * `resolve` back through useLocalSearchParams.
 */
export function conflictResolveHref(operationId: string | null): {
  pathname: "/(tabs)/diagnostics";
  params: { resolve?: string };
} {
  return {
    pathname: "/(tabs)/diagnostics",
    params: operationId ? { resolve: operationId } : {},
  };
}

export interface ConflictFieldRow {
  key: string;
  mine: string;
  server: string;
  differs: boolean;
  /** False when the server copy has no such field at all. */
  serverHas: boolean;
}

/**
 * Your queued fields against the server's current values. Rows are in the
 * order the body was authored, and a field the server copy lacks is still a
 * row — "(not set)" is information, not an omission.
 */
export function conflictFieldRows(
  mine: unknown,
  server: unknown,
): ConflictFieldRow[] {
  const ours = asRecord(mine);
  if (!ours) return [];
  const theirs = asRecord(server) ?? {};
  return Object.keys(ours).map((key) => {
    const serverHas = Object.prototype.hasOwnProperty.call(theirs, key);
    const mineText = valueText(ours[key]);
    const serverText = serverHas ? valueText(theirs[key]) : "(not set)";
    return {
      key,
      mine: mineText,
      server: serverText,
      differs: !serverHas || mineText !== serverText,
      serverHas,
    };
  });
}

/**
 * The body to send after a per-field choice. Never wider than MINE: a field
 * not kept takes the server's current value, and one the server does not
 * hold is dropped. Desktop merges over the whole server record; a phone
 * sending back every server column would smuggle send-state and consent
 * keys past the offline-safety body rules.
 */
export function mergeConflictFields(
  mine: unknown,
  server: unknown,
  keepMine: ReadonlySet<string>,
): Record<string, unknown> | null {
  const ours = asRecord(mine);
  if (!ours) return null;
  const theirs = asRecord(server) ?? {};
  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(ours)) {
    if (keepMine.has(key)) {
      merged[key] = ours[key];
    } else if (Object.prototype.hasOwnProperty.call(theirs, key)) {
      merged[key] = theirs[key];
    }
  }
  return merged;
}

/**
 * The single-record GET routes the server actually mounts for the entities
 * the offline allowlist (lib/offlineQueueSafety) can PATCH. Read off
 * apps/api/internal/routeauth/manifest.json, all viewer: tags and lists have
 * NO `GET /{id}` route there (only `/tags/{id}/history` and list
 * sub-resources), so a conflict on those is resolved without a server copy
 * rather than by GET-ing a path that answers 404.
 */
const READABLE_RECORD_PATHS: readonly RegExp[] = [
  /^\/api\/v1\/campaigns\/[^/?#]+$/,
  /^\/api\/v1\/forms\/[^/?#]+$/,
  /^\/api\/v1\/segments\/[^/?#]+$/,
  /^\/api\/v1\/subscribers\/[^/?#]+$/,
  /^\/api\/v1\/voice\/sequences\/[^/?#]+$/,
];

/**
 * Where the server's current copy lives, or null when there is nothing the
 * phone can read back: a create (no record yet), a sub-resource or membership
 * path, or an entity with no single-record GET. Null means "compare without
 * the server side", never "skip the sheet".
 */
export function serverCopyPath(
  detail: Pick<QueuedWriteDetail, "method" | "path">,
): string | null {
  if (detail.method === "POST") return null;
  return READABLE_RECORD_PATHS.some((pattern) => pattern.test(detail.path))
    ? detail.path
    : null;
}

/** API path prefix → the route-map entity whose mobile screen shows the record. */
const RECORD_ENTITIES: readonly [RegExp, string][] = [
  [/^\/api\/v1\/campaigns\/([^/?#]+)$/, "campaign"],
  [/^\/api\/v1\/forms\/([^/?#]+)$/, "form"],
  [/^\/api\/v1\/segments\/([^/?#]+)$/, "segment"],
  [/^\/api\/v1\/subscribers\/([^/?#]+)$/, "subscriber"],
  [/^\/api\/v1\/lists\/([^/?#]+)$/, "list"],
  [/^\/api\/v1\/voice\/sequences\/([^/?#]+)$/, "sequence"],
];

/**
 * The screen that owns the record a queued write targets, through the shared
 * route map, or null when the phone has no such screen (a tag, a create, a
 * sub-resource) or the id is not one the router accepts. This is the "open
 * the record / open the sequence" remedy the verdicts name.
 */
export function recordHrefForQueuedPath(path: string): string | null {
  for (const [pattern, entity] of RECORD_ENTITIES) {
    const match = pattern.exec(path);
    if (!match?.[1]) continue;
    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return null;
    }
    return mobilePath(entity, id);
  }
  return null;
}

/**
 * A detail GET answers either the bare record or `{ data: record }`; the
 * comparison wants the record. Anything else is handed back untouched so the
 * sheet shows what it got rather than nothing.
 */
export function unwrapServerCopy(payload: unknown): unknown {
  const record = asRecord(payload);
  if (!record) return payload;
  const keys = Object.keys(record);
  if (
    keys.includes("data") &&
    asRecord(record.data) &&
    keys.every((key) => key === "data" || key === "meta" || key === "error")
  ) {
    return record.data;
  }
  return payload;
}

/** Text for one side of a field row; objects print compact JSON. */
export function valueText(value: unknown): string {
  if (value === undefined) return "(not set)";
  if (value === null) return "null";
  if (typeof value === "string") return value === "" ? "(empty)" : value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
