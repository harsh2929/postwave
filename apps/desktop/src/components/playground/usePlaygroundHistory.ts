import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearHistory,
  isPlaygroundHistoryStorageEvent,
  loadPlaygroundHistory,
  removeHistoryEntry,
  subscribeToPlaygroundHistory,
  type HistoryEntry,
} from "./playground-history-storage";

const SAVE_ERROR =
  "The history update could not be encrypted on this device. Existing encrypted history was left unchanged; restore keychain or storage access and retry.";

export function usePlaygroundHistory(identityScope: string | null) {
  const scopeToken = identityScope ?? "unresolved";
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [retry, setRetry] = useState(0);
  const generationRef = useRef(0);

  const refresh = useCallback(
    async (generation: number): Promise<void> => {
      const loaded = await loadPlaygroundHistory(identityScope);
      if (generation !== generationRef.current) return;
      setEntries(loaded.entries);
      setLoadedScope(scopeToken);
      setLoading(false);
      setWarning(loaded.warning);
      setRetryable(loaded.retryable);
    },
    [identityScope, scopeToken],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    setEntries([]);
    setLoading(true);
    setBusy(false);
    setWarning(null);
    setRetryable(false);
    void refresh(generation);
    if (!identityScope) {
      return () => {
        if (generation === generationRef.current) generationRef.current += 1;
      };
    }
    const unsubscribe = subscribeToPlaygroundHistory(identityScope, (event) => {
      if (generation !== generationRef.current) return;
      if (event.error) {
        setWarning(event.error);
        setRetryable(true);
        return;
      }
      void refresh(generation);
    });
    const onStorage = (event: StorageEvent): void => {
      if (
        generation === generationRef.current &&
        isPlaygroundHistoryStorageEvent(event.key, identityScope)
      ) {
        void refresh(generation);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener("storage", onStorage);
      if (generation === generationRef.current) generationRef.current += 1;
    };
  }, [identityScope, refresh, retry]);

  const mutate = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      const generation = generationRef.current;
      setBusy(true);
      try {
        await action();
        if (generation !== generationRef.current) return false;
        await refresh(generation);
        return generation === generationRef.current;
      } catch {
        if (generation === generationRef.current) {
          setWarning(SAVE_ERROR);
          setRetryable(true);
        }
        return false;
      } finally {
        if (generation === generationRef.current) setBusy(false);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    (id: string): Promise<boolean> =>
      mutate(() => removeHistoryEntry(identityScope, id)),
    [identityScope, mutate],
  );
  const clear = useCallback(
    (): Promise<boolean> => mutate(() => clearHistory(identityScope)),
    [identityScope, mutate],
  );
  const retryStorage = useCallback((): void => {
    setRetry((value) => value + 1);
  }, []);

  const ownsRenderedScope = loadedScope === scopeToken;
  return {
    entries: ownsRenderedScope ? entries : [],
    loading: !ownsRenderedScope || loading,
    busy: ownsRenderedScope && busy,
    warning: ownsRenderedScope ? warning : null,
    retryable: ownsRenderedScope && retryable,
    remove,
    clear,
    retryStorage,
  };
}
