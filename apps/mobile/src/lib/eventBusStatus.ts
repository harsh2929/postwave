/**
 * lib/eventBusStatus.ts — the realtime stream's health, made observable.
 *
 * `connectEventBus` has always emitted connecting/open/reconnecting/closed
 * through its `onStatus` callback, and `startEventCacheSync` threw it away
 * (NATIVE#38). The user therefore could not tell "this screen is live" from
 * "this screen froze ten minutes ago because the socket died" — a state that,
 * before the stall watchdog landed, actually persisted forever.
 *
 * Deliberately a tiny external store rather than a zustand slice: it is written
 * from a non-React transport callback on every frame-bearing reconnect, it must
 * be readable from the diagnostics screen, and keeping it dependency-free keeps
 * it unit-testable in the node environment.
 */
import { useSyncExternalStore } from "react";

import type { MobileEventBusStatus } from "@/api/eventBus";

export type EventBusHealthStatus = MobileEventBusStatus | "idle";

export interface EventBusHealth {
  status: EventBusHealthStatus;
  /** When the current status began (epoch ms), or null while idle. */
  changedAt: number | null;
  /** Last time a domain event was received over the live stream. */
  lastEventAt: number | null;
  /** Watchdog-forced reconnects: a socket that went silent (NATIVE#9). */
  stalls: number;
  /** Times the stream was torn down because the app backgrounded. */
  pauses: number;
  /** Last replay cursor reached, or null before the first walk. */
  replayCursor: number | null;
  lastReplayAt: number | null;
  /** Events recovered by the most recent gap walk. */
  lastReplayEvents: number;
  lastReplayReason: string | null;
}

const INITIAL: EventBusHealth = {
  status: "idle",
  changedAt: null,
  lastEventAt: null,
  stalls: 0,
  pauses: 0,
  replayCursor: null,
  lastReplayAt: null,
  lastReplayEvents: 0,
  lastReplayReason: null,
};

let health: EventBusHealth = INITIAL;
const listeners = new Set<() => void>();

function commit(next: EventBusHealth): void {
  health = next;
  for (const listener of [...listeners]) listener();
}

export function getEventBusHealth(): EventBusHealth {
  return health;
}

export function subscribeEventBusHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setEventBusStatus(
  status: EventBusHealthStatus,
  now = Date.now(),
): void {
  if (health.status === status) return;
  commit({ ...health, status, changedAt: now });
}

export function noteEventBusEvent(now = Date.now()): void {
  commit({ ...health, lastEventAt: now });
}

export function noteEventBusStall(): void {
  commit({ ...health, stalls: health.stalls + 1 });
}

export function noteEventBusPause(): void {
  commit({ ...health, pauses: health.pauses + 1 });
}

export function noteEventBusReplay(input: {
  cursor: number;
  events: number;
  reason: string;
  now?: number;
}): void {
  commit({
    ...health,
    replayCursor: input.cursor,
    lastReplayAt: input.now ?? Date.now(),
    lastReplayEvents: input.events,
    lastReplayReason: input.reason,
  });
}

/** Full reset — used on sign-out and by tests. */
export function resetEventBusHealth(): void {
  commit(INITIAL);
}

export type EventBusFreshnessTone = "live" | "degraded" | "off";

export interface EventBusFreshness {
  tone: EventBusFreshnessTone;
  label: string;
  /** Spoken form; a coloured dot alone is never the only signal. */
  accessibilityLabel: string;
}

/**
 * Map health onto the three states a person can act on. `open` is only called
 * live while the socket has actually said something recently — the whole point
 * of NATIVE#9 is that an "open" socket can be silently dead.
 */
export function eventBusFreshness(
  current: EventBusHealth = health,
  now = Date.now(),
  silenceToleranceMs = 90_000,
): EventBusFreshness {
  switch (current.status) {
    case "open": {
      const silentFor =
        current.changedAt === null
          ? 0
          : now - Math.max(current.changedAt, current.lastEventAt ?? 0);
      if (silentFor > silenceToleranceMs) {
        return {
          tone: "degraded",
          label: "Checking…",
          accessibilityLabel: "Live updates: checking the connection",
        };
      }
      return {
        tone: "live",
        label: "Live",
        accessibilityLabel: "Live updates: connected",
      };
    }
    case "connecting":
    case "reconnecting":
      return {
        tone: "degraded",
        label: "Reconnecting…",
        accessibilityLabel: "Live updates: reconnecting",
      };
    case "unsupported":
      return {
        tone: "off",
        label: "Not live",
        accessibilityLabel:
          "Live updates unavailable on this device; pull to refresh",
      };
    case "closed":
    case "idle":
    default:
      return {
        tone: "off",
        label: "Paused",
        accessibilityLabel: "Live updates paused; pull to refresh",
      };
  }
}

/** React binding for the freshness indicator + diagnostics screen. */
export function useEventBusHealth(): EventBusHealth {
  return useSyncExternalStore(
    subscribeEventBusHealth,
    getEventBusHealth,
    getEventBusHealth,
  );
}
