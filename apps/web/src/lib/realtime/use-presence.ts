// SPDX-License-Identifier: AGPL-3.0-only
//
// Web presence hook (Apple-level integration dim 5 — presence beyond desktop).
// Subscribes to the server `presence.update` event over the SAME realtime
// transport the cache-invalidation layer uses, via a dedicated topic
// subscription (connectRealtimeBus's `topics` option) — so it needs no change
// to the invalidation bus. The wire types are the shared @postwave/notifications
// PresencePayload (the same ones desktop reads).
"use client";

import { useEffect, useState } from "react";

import type { PresencePayload, PresenceUserV2 } from "@postwave/notifications";

import { connectRealtimeBus } from "./event-bus-client";

const EMPTY: PresencePayload = { count: 0 };

export function usePresence(): PresencePayload {
  const [presence, setPresence] = useState<PresencePayload>(EMPTY);
  useEffect(() => {
    const stop = connectRealtimeBus(
      (evt) => {
        if (evt.topic !== "presence.update") return;
        const payload = (evt.payload ?? {}) as PresencePayload;
        setPresence(payload);
      },
      undefined,
      // No gap recovery: presence rows are persisted like every other event,
      // so a reconnect would replay a HISTORICAL viewer list on top of the
      // fresh snapshot the re-subscribe just produced — and the stale one wins
      // because it arrives second. "Who is here now" has no gap to recover.
      { topics: ["presence.update"], recover: false },
    );
    return stop;
  }, []);
  return presence;
}

// entity payloads carry the record ref so a client can ignore other records'
// events on the shared presence.entity topic.
type EntityPresencePayload = PresencePayload & { entity_ref?: string };

/**
 * Per-record presence (SHELL-036). Opens an SSE connection scoped to
 * `entityRef` (e.g. "campaign:abc") and returns who else is viewing THAT
 * record. The server tracks membership from the `entity` query param; events
 * arrive on the `presence.entity` topic and are filtered to this ref. Passing a
 * falsy ref disconnects and reports empty (so a component can gate on load).
 */
export function useEntityPresence(
  entityRef: string | null | undefined,
): PresencePayload {
  const [presence, setPresence] = useState<PresencePayload>(EMPTY);
  useEffect(() => {
    if (!entityRef) {
      setPresence(EMPTY);
      return;
    }
    setPresence(EMPTY);
    const stop = connectRealtimeBus(
      (evt) => {
        if (evt.topic !== "presence.entity") return;
        const payload = (evt.payload ?? {}) as EntityPresencePayload;
        if (payload.entity_ref !== entityRef) return; // only THIS record
        setPresence(payload);
      },
      undefined,
      {
        topics: ["presence.entity"],
        recover: false, // ephemeral — see usePresence above
        buildUrl: (topicsCsv) =>
          `/api/v1/events?topics=${encodeURIComponent(
            topicsCsv,
          )}&entity=${encodeURIComponent(entityRef)}`,
      },
    );
    return stop;
  }, [entityRef]);
  return presence;
}

export interface PresenceSummary {
  /** Unique people worth showing (labelled, de-placeholdered). */
  viewers: PresenceUserV2[];
  /** Best available distinct-person count (including the viewer). */
  total: number;
  /** How many distinct people are present beyond the viewer. */
  others: number;
}

// A synthetic label the server emits only in no-auth dev mode — folded into the
// count rather than shown as a fake avatar.
const PLACEHOLDER = /^user-\d+$/i;

/**
 * Reduce a raw presence payload to what the indicator renders. Pure + exported
 * for testing. Prefers the structured `users_v2`; falls back to the legacy
 * flat `users`; drops dev placeholders; caps the shown list at `max`.
 */
export function summarizePresence(
  payload: PresencePayload | null | undefined,
  max = 3,
): PresenceSummary {
  const p = payload ?? {};
  const connectionCount =
    typeof p.count === "number" && p.count > 0 ? p.count : 0;
  const structured: PresenceUserV2[] = Array.isArray(p.users_v2)
    ? p.users_v2
    : Array.isArray(p.users)
      ? p.users.map((label) => ({ label }))
      : [];
  // The API deliberately counts SSE connections, so the same person with
  // multiple tabs/devices can occur several times with the same id. The UI is
  // about collaborators, not sockets: collapse those duplicates before
  // rendering keys, avatars, and the "people online" total. For legacy rows
  // without ids, a normalized label is the only stable identity available.
  const seen = new Set<string>();
  const unique = structured.filter((user) => {
    const id = user.id?.trim();
    const label = user.label?.trim().toLocaleLowerCase();
    const key = id ? `id:${id}` : label ? `label:${label}` : null;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const duplicateConnections = structured.length - unique.length;
  const total = Math.max(
    unique.length,
    connectionCount - duplicateConnections,
  );
  const named = unique.filter(
    (u) => u.label && !PLACEHOLDER.test(u.label),
  );
  return {
    viewers: named.slice(0, max),
    total,
    others: Math.max(0, total - 1),
  };
}
