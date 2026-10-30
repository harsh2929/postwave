// SPDX-License-Identifier: AGPL-3.0-only
//
// API playground favorites and local history, keyed per workspace AND
// principal so one browser shared by two operators — or one operator in two
// workspaces — never shows another identity's routes.
//
// History is deliberately thin (desktop PlaygroundHistory contract): method,
// route TEMPLATE, status, timing and the outcome class. No parameter values,
// no header values, no bodies, no response content — those can carry
// subscriber PII or secrets and localStorage is readable by any script on the
// origin. A replay therefore opens a blank draft.
//
// Both are conveniences: every read and write is wrapped so private mode, a
// full quota, or a corrupt value degrades to "nothing stored", never a crash.

import type { PlaygroundResponse } from "@/lib/api-playground-transport";
import { newUUIDv7 } from "@/lib/http-fetch";

const FAVORITES_PREFIX = "postwave:api-playground:favorites:v1";
const HISTORY_PREFIX = "postwave:api-playground:history:v1";
export const PLAYGROUND_FAVORITES_MAX = 100;
export const PLAYGROUND_HISTORY_MAX = 50;

export interface PlaygroundHistoryEntry {
  id: string;
  at: string;
  method: string;
  pathTemplate: string;
  status: number;
  durationMs: number;
  outcome: PlaygroundResponse["outcome"];
  ambiguous: boolean;
}

export function playgroundStorageScope(
  tenantId: string | undefined,
  userId: string | undefined,
): string | null {
  return tenantId && userId ? `${tenantId}:${userId}` : null;
}

export function playgroundFavoritesKey(scope: string): string {
  return `${FAVORITES_PREFIX}:${scope}`;
}

export function playgroundHistoryKey(scope: string): string {
  return `${HISTORY_PREFIX}:${scope}`;
}

function readJSON(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable — the convenience stays in memory for this tab.
  }
}

export function readPlaygroundFavorites(
  scope: string | null,
  allowed: ReadonlySet<string>,
): Set<string> {
  if (!scope) return new Set();
  const value = readJSON(playgroundFavoritesKey(scope));
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .filter((item): item is string => typeof item === "string" && allowed.has(item))
      .slice(0, PLAYGROUND_FAVORITES_MAX),
  );
}

export function writePlaygroundFavorites(
  scope: string | null,
  favorites: ReadonlySet<string>,
): void {
  if (!scope) return;
  writeJSON(
    playgroundFavoritesKey(scope),
    [...favorites].slice(0, PLAYGROUND_FAVORITES_MAX),
  );
}

function isHistoryEntry(value: unknown): value is PlaygroundHistoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.at === "string" &&
    typeof entry.method === "string" &&
    typeof entry.pathTemplate === "string" &&
    typeof entry.status === "number" &&
    typeof entry.durationMs === "number" &&
    (entry.outcome === "http" ||
      entry.outcome === "aborted" ||
      entry.outcome === "timeout" ||
      entry.outcome === "network") &&
    typeof entry.ambiguous === "boolean"
  );
}

export function readPlaygroundHistory(
  scope: string | null,
): PlaygroundHistoryEntry[] {
  if (!scope) return [];
  const value = readJSON(playgroundHistoryKey(scope));
  return Array.isArray(value)
    ? value.filter(isHistoryEntry).slice(0, PLAYGROUND_HISTORY_MAX)
    : [];
}

/** Prepend one attempt and return the list now stored (newest first). */
export function appendPlaygroundHistory(
  scope: string | null,
  entry: Omit<PlaygroundHistoryEntry, "id" | "at">,
  current: readonly PlaygroundHistoryEntry[],
): PlaygroundHistoryEntry[] {
  const next = [
    {
      id: newUUIDv7(),
      at: new Date().toISOString(),
      method: entry.method,
      pathTemplate: entry.pathTemplate,
      status: entry.status,
      durationMs: entry.durationMs,
      outcome: entry.outcome,
      ambiguous: entry.ambiguous,
    },
    ...current,
  ].slice(0, PLAYGROUND_HISTORY_MAX);
  if (scope) writeJSON(playgroundHistoryKey(scope), next);
  return next;
}

export function clearPlaygroundHistory(scope: string | null): void {
  if (!scope) return;
  try {
    window.localStorage.removeItem(playgroundHistoryKey(scope));
  } catch {
    // Nothing stored or storage unavailable; the in-memory list is cleared.
  }
}
