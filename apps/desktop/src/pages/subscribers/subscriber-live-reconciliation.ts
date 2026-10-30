import type { Subscriber } from "../../lib/api-client";
import type { OfflineMutation } from "../../lib/offline-store";
import { subscriberKey } from "./subscribers-page-utils";

const SUBSCRIBER_RECORD_PATH =
  /\/api\/v1\/subscribers\/([^/?#]+)\/?(?:[?#].*)?$/u;
const DIRECTORY_PATCH_FIELDS = new Set([
  "display_name",
  "email",
  "first_name",
  "full_name",
  "last_name",
  "status",
  "tags",
]);

export interface SubscriberQueuedPatch {
  queueId: string;
  subscriberId: string;
  patch: Partial<Subscriber>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Project only directory-safe fields from an unresolved subscriber PATCH.
 *
 * The encrypted outbox is authoritative for locally accepted offline writes.
 * Reapplying this bounded projection after a list refresh prevents an unrelated
 * live event from visually rolling that accepted change back before replay.
 */
export function subscriberQueuedPatch(
  mutation: OfflineMutation,
): SubscriberQueuedPatch | null {
  if (mutation.resource !== "subscribers") return null;
  if (mutation.method.toUpperCase() !== "PATCH") return null;
  const match = SUBSCRIBER_RECORD_PATH.exec(mutation.path);
  if (!match?.[1]) return null;
  let subscriberId: string;
  try {
    subscriberId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!subscriberId || subscriberId === "." || subscriberId === "..") {
    return null;
  }
  const body = record(mutation.body);
  if (!body) return null;
  const patch: Partial<Subscriber> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!DIRECTORY_PATCH_FIELDS.has(key)) continue;
    if (key === "tags") {
      if (
        Array.isArray(value) &&
        value.every((tag) => typeof tag === "string")
      ) {
        patch.tags = [...value];
      }
      continue;
    }
    if (typeof value === "string" || value === null) {
      (patch as Record<string, unknown>)[key] = value;
    }
  }
  return Object.keys(patch).length > 0
    ? { queueId: mutation.id, subscriberId, patch }
    : null;
}

/** Apply queued patches in journal order, preserving per-resource FIFO. */
export function queuedSubscriberPatches(
  mutations: readonly OfflineMutation[],
): ReadonlyMap<string, Partial<Subscriber>> {
  const patches = new Map<string, Partial<Subscriber>>();
  for (const mutation of mutations) {
    const projected = subscriberQueuedPatch(mutation);
    if (!projected) continue;
    patches.set(projected.subscriberId, {
      ...(patches.get(projected.subscriberId) ?? {}),
      ...projected.patch,
    });
  }
  return patches;
}

export interface LocalMutationMarker {
  revision: number;
  present: boolean;
}

/**
 * Reconcile one server page with local changes that happened after the request
 * began and unresolved outbox projections. A stale response may update other
 * rows, but it cannot overwrite or resurrect a row changed during its flight.
 */
export function reconcileSubscriberPage(input: {
  serverRows: readonly Subscriber[];
  currentRows: readonly Subscriber[] | null;
  requestMutationRevision: number;
  /** Keys whose mutations were already active when this request started. */
  activeMutationKeysAtRequest?: ReadonlySet<string>;
  localMarkers: ReadonlyMap<string, LocalMutationMarker>;
  queuedPatches: ReadonlyMap<string, Partial<Subscriber>>;
}): { rows: Subscriber[]; crossedMutationBoundary: boolean } {
  const currentByKey = new Map(
    (input.currentRows ?? []).map((row) => [subscriberKey(row), row]),
  );
  let crossedMutationBoundary = false;
  const rows: Subscriber[] = [];
  for (const serverRow of input.serverRows) {
    const key = subscriberKey(serverRow);
    const marker = input.localMarkers.get(key);
    if (
      marker &&
      (marker.revision > input.requestMutationRevision ||
        input.activeMutationKeysAtRequest?.has(key))
    ) {
      crossedMutationBoundary = true;
      if (!marker.present) continue;
      const current = currentByKey.get(key);
      if (current) {
        rows.push(current);
        continue;
      }
    }
    const id = serverRow.id == null ? "" : String(serverRow.id);
    const queued = id ? input.queuedPatches.get(id) : undefined;
    rows.push(queued ? { ...serverRow, ...queued } : serverRow);
  }
  return { rows, crossedMutationBoundary };
}
