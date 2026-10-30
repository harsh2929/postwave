import { useCallback, useRef } from "react";

import type { LocalMutationMarker } from "./subscriber-live-reconciliation";

export function useSubscriberMutationLedger(reload: () => void) {
  const revisionRef = useRef(0);
  const tokenRef = useRef(0);
  const activeTokensRef = useRef(new Map<number, string>());
  const localMarkersRef = useRef(new Map<string, LocalMutationMarker>());
  const reconcileAfterMutationsRef = useRef(false);

  const begin = useCallback((key: string): number => {
    const token = ++tokenRef.current;
    const revision = ++revisionRef.current;
    activeTokensRef.current.set(token, key);
    localMarkersRef.current.set(key, { revision, present: true });
    return token;
  }, []);

  const finish = useCallback(
    (token: number, options: { present?: boolean } = {}): void => {
      const key = activeTokensRef.current.get(token);
      if (!key) return;
      activeTokensRef.current.delete(token);
      localMarkersRef.current.set(key, {
        revision: ++revisionRef.current,
        present: options.present ?? true,
      });
      if (
        activeTokensRef.current.size === 0 &&
        reconcileAfterMutationsRef.current
      ) {
        reconcileAfterMutationsRef.current = false;
        reload();
      }
    },
    [reload],
  );

  const mark = useCallback((key: string, present = true): void => {
    localMarkersRef.current.set(key, {
      revision: ++revisionRef.current,
      present,
    });
  }, []);

  const reset = useCallback((): void => {
    activeTokensRef.current.clear();
    localMarkersRef.current.clear();
    reconcileAfterMutationsRef.current = false;
    revisionRef.current += 1;
  }, []);

  return {
    revisionRef,
    activeTokensRef,
    localMarkersRef,
    reconcileAfterMutationsRef,
    begin,
    finish,
    mark,
    reset,
  };
}

export type SubscriberMutationLedger = ReturnType<
  typeof useSubscriberMutationLedger
>;
