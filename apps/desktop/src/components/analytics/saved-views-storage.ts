import { useCallback, useEffect, useRef, useState } from "react";

import {
  loadSensitiveLocalData,
  saveSensitiveLocalData,
  type SanitizedLocalData,
} from "../../lib/sensitive-local-data";
import { purgeLegacySavedViews } from "./saved-views-legacy";

export type AnalyticsRange = "7d" | "30d" | "90d";

export interface SavedView {
  id: string;
  name: string;
  range: AnalyticsRange;
  vsPrevious: boolean;
}

export const MAX_VIEW_NAME = 60;
export const MAX_SAVED_VIEWS = 20;
export const SAVED_VIEWS_VAULT_NAMESPACE = "analytics-saved-views";
const MAX_LIBRARY_BYTES = 64 * 1024;
const MAX_VIEW_ID = 128;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

interface StorageState {
  scope: string | null;
  views: SavedView[];
  phase: "loading" | "ready" | "unavailable";
  busy: boolean;
  notice: string | null;
  retryable: boolean;
}

export interface SavedViewsMutationResult {
  ok: boolean;
  error?: string;
  stale?: boolean;
}

export interface SavedViewsStorage {
  views: SavedView[];
  loading: boolean;
  unavailable: boolean;
  busy: boolean;
  notice: string | null;
  retryable: boolean;
  add: (view: SavedView) => Promise<SavedViewsMutationResult>;
  remove: (id: string) => Promise<SavedViewsMutationResult>;
  retry: () => void;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function canonicalSavedView(value: unknown): SavedView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<SavedView>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (
    typeof candidate.id !== "string" ||
    !candidate.id ||
    candidate.id.length > MAX_VIEW_ID ||
    CONTROL_RE.test(candidate.id) ||
    !name ||
    name.length > MAX_VIEW_NAME ||
    CONTROL_RE.test(name) ||
    (candidate.range !== "7d" &&
      candidate.range !== "30d" &&
      candidate.range !== "90d") ||
    typeof candidate.vsPrevious !== "boolean"
  ) {
    return null;
  }
  return {
    id: candidate.id,
    name,
    range: candidate.range,
    vsPrevious: candidate.vsPrevious,
  };
}

export function sanitizeSavedViews(
  candidate: unknown,
): SanitizedLocalData<SavedView[]> | null {
  if (!Array.isArray(candidate)) return null;
  const views: SavedView[] = [];
  const ids = new Set<string>();
  let altered = candidate.length > MAX_SAVED_VIEWS;
  for (const raw of candidate.slice(0, MAX_SAVED_VIEWS * 2)) {
    const view = canonicalSavedView(raw);
    if (!view || ids.has(view.id) || views.length >= MAX_SAVED_VIEWS) {
      altered = true;
      continue;
    }
    ids.add(view.id);
    views.push(view);
    try {
      altered ||= JSON.stringify(raw) !== JSON.stringify(view);
    } catch {
      altered = true;
    }
  }
  while (views.length > 0 && byteLength(views) > MAX_LIBRARY_BYTES) {
    views.pop();
    altered = true;
  }
  return { value: views, altered };
}

function combinedNotice(...parts: Array<string | null>): string | null {
  return parts.filter(Boolean).join(" ") || null;
}

function emptyState(scope: string | null): StorageState {
  return {
    scope,
    views: [],
    phase: "loading",
    busy: false,
    notice: null,
    retryable: false,
  };
}

export function useEncryptedSavedViews(
  storageScope: string | null,
): SavedViewsStorage {
  const [state, setState] = useState<StorageState>(() =>
    emptyState(storageScope),
  );
  const [retryToken, setRetryToken] = useState(0);
  const generationRef = useRef(0);
  const durableRef = useRef(state);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  durableRef.current = state;

  useEffect(() => {
    const generation = ++generationRef.current;
    let active = true;
    const initial = emptyState(storageScope);
    durableRef.current = initial;
    setState(initial);
    const legacy = purgeLegacySavedViews();
    void loadSensitiveLocalData({
      identityScope: storageScope,
      namespace: SAVED_VIEWS_VAULT_NAMESPACE,
      fallback: [] as SavedView[],
      validate: sanitizeSavedViews,
    })
      .then((loaded) => {
        if (!active || generation !== generationRef.current) return;
        const next: StorageState = {
          scope: storageScope,
          views: loaded.value,
          phase: loaded.state,
          busy: false,
          notice: combinedNotice(loaded.warning, legacy.notice),
          retryable: loaded.retryable || legacy.failed,
        };
        durableRef.current = next;
        setState(next);
      })
      .catch(() => {
        if (!active || generation !== generationRef.current) return;
        const next: StorageState = {
          scope: storageScope,
          views: [],
          phase: "unavailable",
          busy: false,
          notice: combinedNotice(
            "Encrypted saved views couldn't be opened. Existing ciphertext was left untouched. Retry encrypted storage.",
            legacy.notice,
          ),
          retryable: true,
        };
        durableRef.current = next;
        setState(next);
      });
    return () => {
      active = false;
      if (generation === generationRef.current) generationRef.current += 1;
    };
  }, [retryToken, storageScope]);

  const mutate = useCallback(
    (
      update: (views: SavedView[]) =>
        | { views: SavedView[] }
        | { error: string },
    ): Promise<SavedViewsMutationResult> => {
      const scope = storageScope;
      const generation = generationRef.current;
      let resolveResult!: (result: SavedViewsMutationResult) => void;
      const result = new Promise<SavedViewsMutationResult>((resolve) => {
        resolveResult = resolve;
      });
      writeQueueRef.current = writeQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const current = durableRef.current;
          if (generation !== generationRef.current || current.scope !== scope) {
            resolveResult({ ok: false, stale: true });
            return;
          }
          if (!scope || current.phase !== "ready") {
            resolveResult({
              ok: false,
              error: "Encrypted saved views are unavailable. Retry storage first.",
            });
            return;
          }
          const proposal = update(current.views);
          if ("error" in proposal) {
            resolveResult({ ok: false, error: proposal.error });
            return;
          }
          const checked = sanitizeSavedViews(proposal.views);
          if (!checked || checked.altered) {
            resolveResult({
              ok: false,
              error: "Saved views exceed the 20-view or 64 KB encrypted limit.",
            });
            return;
          }
          const busyState = { ...current, busy: true, notice: null };
          durableRef.current = busyState;
          setState(busyState);
          try {
            const saved = await saveSensitiveLocalData({
              identityScope: scope,
              namespace: SAVED_VIEWS_VAULT_NAMESPACE,
              validate: sanitizeSavedViews,
              value: checked.value,
            });
            if (generation !== generationRef.current) {
              resolveResult({ ok: false, stale: true });
              return;
            }
            const next = { ...durableRef.current, views: saved, busy: false };
            durableRef.current = next;
            setState(next);
            resolveResult({ ok: true });
          } catch {
            if (generation === generationRef.current) {
              const next = {
                ...durableRef.current,
                busy: false,
                notice:
                  "Saved views couldn't be encrypted. Existing durable views were left unchanged.",
                retryable: true,
              };
              durableRef.current = next;
              setState(next);
            }
            resolveResult({
              ok: false,
              error: "Saved views couldn't be encrypted. Try again.",
            });
          }
        });
      return result;
    },
    [storageScope],
  );

  const visible = state.scope === storageScope ? state : emptyState(storageScope);
  return {
    views: visible.views,
    loading: visible.phase === "loading",
    unavailable: visible.phase === "unavailable",
    busy: visible.busy,
    notice: visible.notice,
    retryable: visible.retryable,
    add: (view) =>
      mutate((views) =>
        views.length >= MAX_SAVED_VIEWS
          ? { error: "Remove a saved view before adding another (maximum 20)." }
          : { views: [...views, view] },
      ),
    remove: (id) =>
      mutate((views) =>
        views.some((view) => view.id === id)
          ? { views: views.filter((view) => view.id !== id) }
          : { error: "That saved view is no longer available." },
      ),
    retry: () => setRetryToken((value) => value + 1),
  };
}
