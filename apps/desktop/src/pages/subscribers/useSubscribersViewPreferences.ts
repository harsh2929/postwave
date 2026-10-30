import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type SubscribersViewPrefs,
  getSubscribersViewPrefs,
  putSubscribersViewPrefs,
} from "../../lib/api-client";
import {
  registerLifecycleGuard,
  signalLifecycleOwnerChanged,
} from "../../lib/lifecycle-coordinator";
import {
  subscriberGridTemplate,
  visibleSubscriberColumns,
} from "../subscribers-view-columns";
import { toast } from "../../components/Toast";
import { redact } from "../../lib/auth";

export function useSubscribersViewPreferences(identityScope: string | null) {
  const [viewPrefs, setViewPrefs] = useState<SubscribersViewPrefs>({});
  const [preferencesLoading, setPreferencesLoading] = useState(true);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const prefsLoadedRef = useRef(false);
  const prefsDebounceRef = useRef<number | null>(null);
  const pendingPrefsRef = useRef<SubscribersViewPrefs | null>(null);
  const confirmedPrefsRef = useRef<SubscribersViewPrefs>({});
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());
  const persistCountRef = useRef(0);
  const activeRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const identityScopeRef = useRef(identityScope);
  identityScopeRef.current = identityScope;

  const visibleColumnKeys = useMemo(
    () => visibleSubscriberColumns(viewPrefs),
    [viewPrefs],
  );
  const gridTemplateColumns = useMemo(
    () => subscriberGridTemplate(visibleColumnKeys),
    [visibleColumnKeys],
  );

  const flushPreferences = useCallback(async (): Promise<void> => {
    if (prefsDebounceRef.current != null) {
      window.clearTimeout(prefsDebounceRef.current);
      prefsDebounceRef.current = null;
    }
    const pending = pendingPrefsRef.current;
    pendingPrefsRef.current = null;
    if (!pending) {
      await persistChainRef.current;
      return;
    }
    persistCountRef.current += 1;
    const ownerScope = identityScopeRef.current;
    const run = persistChainRef.current.then(async () => {
      const response = await putSubscribersViewPrefs(pending);
      if (ownerScope !== identityScopeRef.current) return;
      if (response.error) {
        pendingPrefsRef.current = pending;
        if (activeRef.current) {
          setPreferencesError(redact(response.error.message));
          toast.error(
            `Couldn't save column preferences: ${redact(response.error.message)}`,
          );
        }
      } else if (response.data) {
        confirmedPrefsRef.current = pending;
        if (activeRef.current) setPreferencesError(null);
      }
    });
    persistChainRef.current = run.finally(() => {
      persistCountRef.current = Math.max(0, persistCountRef.current - 1);
      signalLifecycleOwnerChanged();
    });
    await persistChainRef.current;
  }, []);

  const loadPreferences = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequenceRef.current;
    setPreferencesLoading(true);
    setPreferencesError(null);
    try {
      const response = await getSubscribersViewPrefs();
      if (!activeRef.current || sequence !== loadSequenceRef.current) return;
      if (response.data) {
        confirmedPrefsRef.current = response.data;
        // Never let a late GET overwrite columns the user changed while the
        // request was in flight.
        if (pendingPrefsRef.current === null) setViewPrefs(response.data);
      } else {
        setPreferencesError(
          redact(
            response.error?.message ?? "Column preferences are unavailable.",
          ),
        );
      }
    } catch {
      if (activeRef.current && sequence === loadSequenceRef.current) {
        setPreferencesError("Column preferences are unavailable.");
      }
    } finally {
      if (activeRef.current && sequence === loadSequenceRef.current) {
        prefsLoadedRef.current = true;
        setPreferencesLoading(false);
      }
    }
  }, [identityScope]);

  useEffect(() => {
    // A mounted page can survive a workspace switch. Never carry an unsaved
    // old-workspace layout into the next identity or accept its late GET.
    loadSequenceRef.current += 1;
    if (prefsDebounceRef.current != null) {
      window.clearTimeout(prefsDebounceRef.current);
      prefsDebounceRef.current = null;
    }
    pendingPrefsRef.current = null;
    confirmedPrefsRef.current = {};
    prefsLoadedRef.current = false;
    setViewPrefs({});
    void loadPreferences();
  }, [identityScope, loadPreferences]);

  useEffect(() => {
    return registerLifecycleGuard({
      id: "subscriber-view-preferences",
      label: "Subscriber table preferences",
      inspect: (intent) => {
        if (intent.disposition === "hide") return null;
        if (pendingPrefsRef.current === null && persistCountRef.current === 0) {
          return null;
        }
        return {
          level: "blocking",
          detail: "The latest subscriber column preferences are still saving.",
          canDiscard: persistCountRef.current === 0,
        };
      },
      prepare: flushPreferences,
      discard: () => {
        if (persistCountRef.current > 0) {
          throw new Error("subscriber_preferences_save_active");
        }
        if (prefsDebounceRef.current != null) {
          window.clearTimeout(prefsDebounceRef.current);
          prefsDebounceRef.current = null;
        }
        pendingPrefsRef.current = null;
        if (activeRef.current) setViewPrefs(confirmedPrefsRef.current);
        signalLifecycleOwnerChanged();
      },
    });
  }, [flushPreferences]);

  const updateVisibleColumns = (next: string[]): void => {
    const withEmail = next.includes("email") ? next : ["email", ...next];
    const merged: SubscribersViewPrefs = { ...viewPrefs, columns: withEmail };
    setViewPrefs(merged);
    pendingPrefsRef.current = merged;
    signalLifecycleOwnerChanged();
    if (prefsDebounceRef.current != null) {
      window.clearTimeout(prefsDebounceRef.current);
    }
    prefsDebounceRef.current = window.setTimeout(() => {
      void flushPreferences();
    }, 500);
  };

  const retryPreferences = (): void => {
    if (pendingPrefsRef.current) void flushPreferences();
    else void loadPreferences();
  };

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      // A route change must not drop the trailing preference update.
      void flushPreferences();
    };
  }, [flushPreferences]);

  return {
    visibleColumnKeys,
    gridTemplateColumns,
    updateVisibleColumns,
    preferencesLoading,
    preferencesError,
    retryPreferences,
  };
}

export type SubscribersViewPreferences = ReturnType<
  typeof useSubscribersViewPreferences
>;
