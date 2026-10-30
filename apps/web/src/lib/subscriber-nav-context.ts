// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Lightweight prev/next context for the subscriber drill-down. The list writes
// the id order of the current (filtered/sorted) page into sessionStorage before
// navigating; the detail page reads it to offer previous/next navigation
// seeded from wherever the operator came from. Session-scoped so it never
// leaks across tabs or survives a full app restart.

const KEY = "postwave:subscriber-nav-order";

export function setSubscriberNavOrder(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable (private mode / quota) — prev/next just won't show */
  }
}

function readOrder(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Neighbors of `id` in the last-seen list order. Pure given a supplied order. */
export function neighborsOf(
  order: string[],
  id: string,
): { prev: string | null; next: string | null; index: number; total: number } {
  const index = order.indexOf(id);
  if (index === -1) {
    return { prev: null, next: null, index: -1, total: order.length };
  }
  return {
    prev: index > 0 ? order[index - 1]! : null,
    next: index < order.length - 1 ? order[index + 1]! : null,
    index,
    total: order.length,
  };
}

export function getSubscriberNeighbors(id: string) {
  return neighborsOf(readOrder(), id);
}
