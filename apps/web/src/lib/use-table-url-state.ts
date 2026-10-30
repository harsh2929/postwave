// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// React binding for the pure `table-url-state` core. Reflects list state
// (page / search / filters / sort) into the URL via a shallow
// `router.replace`, so refresh, deep-links, and the browser Back button all
// restore the operator's place. Shared so subscribers/segments/campaigns can
// adopt one idiom; the parse/serialize logic itself is unit-tested in
// `table-url-state.test.ts`.

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { asRoute } from "@/lib/typed-routes";
import {
  parseParams,
  serializeParamsString,
  type Schema,
  type StateOf,
} from "@/lib/table-url-state";

export function useTableUrlState<S extends Schema>(
  schema: S,
): {
  state: StateOf<S>;
  setState: (patch: Partial<StateOf<S>>) => void;
  reset: () => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Re-derive on every searchParams change so Back/Forward stay in sync.
  const searchKey = searchParams.toString();
  const urlState = useMemo(
    () => parseParams(schema, (key) => searchParams.get(key)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schema, searchKey],
  );
  const defaults = useMemo(() => parseParams(schema, () => null), [schema]);

  type NavigationTarget = {
    searchKey: string;
    state: StateOf<S>;
  };
  type PendingNavigation = {
    baseSearchKey: string;
    inFlight: NavigationTarget;
    pathname: string;
    queued: NavigationTarget | null;
    schema: S;
  };

  // Next publishes search params asynchronously. Serialize our replacements
  // and keep only the newest queued target so an intermediate publication can
  // never downgrade the state used by a later control event.
  const [optimisticState, setOptimisticState] = useState(urlState);
  const latestStateRef = useRef(urlState);
  const currentSearchKeyRef = useRef(searchKey);
  const pendingNavigationRef = useRef<PendingNavigation | null>(null);
  currentSearchKeyRef.current = searchKey;

  let pendingNavigation = pendingNavigationRef.current;
  if (
    pendingNavigation &&
    (pendingNavigation.pathname !== pathname ||
      pendingNavigation.schema !== schema)
  ) {
    pendingNavigationRef.current = null;
    pendingNavigation = null;
  }

  if (pendingNavigation) {
    const knownInternalPublication =
      searchKey === pendingNavigation.baseSearchKey ||
      searchKey === pendingNavigation.inFlight.searchKey;
    if (!knownInternalPublication) {
      // The URL moved somewhere we did not request: Back/Forward, a same-route
      // link, or another external navigation wins over pending local intent.
      pendingNavigationRef.current = null;
      pendingNavigation = null;
      latestStateRef.current = urlState;
    }
  } else {
    latestStateRef.current = urlState;
  }

  const replaceSearchKey = useCallback(
    (nextSearchKey: string) => {
      router.replace(
        asRoute(nextSearchKey ? `${pathname}?${nextSearchKey}` : pathname),
        {
          scroll: false,
        },
      );
    },
    [pathname, router],
  );

  useEffect(() => {
    const navigation = pendingNavigationRef.current;
    if (
      !navigation ||
      navigation.pathname !== pathname ||
      navigation.schema !== schema ||
      searchKey !== navigation.inFlight.searchKey
    ) {
      return;
    }

    const queued = navigation.queued;
    if (queued && queued.searchKey !== searchKey) {
      navigation.baseSearchKey = searchKey;
      navigation.inFlight = queued;
      navigation.queued = null;
      replaceSearchKey(queued.searchKey);
      return;
    }

    pendingNavigationRef.current = null;
    latestStateRef.current = urlState;
  }, [pathname, replaceSearchKey, schema, searchKey, urlState]);

  const commit = useCallback(
    (next: StateOf<S>) => {
      const target: NavigationTarget = {
        searchKey: serializeParamsString(schema, next),
        state: next,
      };
      latestStateRef.current = next;
      setOptimisticState(next);

      const navigation = pendingNavigationRef.current;
      if (
        navigation &&
        navigation.pathname === pathname &&
        navigation.schema === schema
      ) {
        // A newer target supersedes anything queued. If intent returns to the
        // in-flight target, the queue can be discarded entirely.
        navigation.queued =
          target.searchKey === navigation.inFlight.searchKey ? null : target;
        return;
      }

      pendingNavigationRef.current = null;
      if (target.searchKey === currentSearchKeyRef.current) return;

      pendingNavigationRef.current = {
        baseSearchKey: currentSearchKeyRef.current,
        inFlight: target,
        pathname,
        queued: null,
        schema,
      };
      replaceSearchKey(target.searchKey);
    },
    [pathname, replaceSearchKey, schema],
  );

  const setState = useCallback(
    (patch: Partial<StateOf<S>>) => {
      const next = { ...latestStateRef.current, ...patch } as StateOf<S>;
      commit(next);
    },
    [commit],
  );

  const reset = useCallback(() => {
    commit(defaults);
  }, [commit, defaults]);

  const latestInternalTargetPublished = Boolean(
    pendingNavigation &&
    searchKey === pendingNavigation.inFlight.searchKey &&
    pendingNavigation.queued === null,
  );

  return {
    state:
      pendingNavigation && !latestInternalTargetPublished
        ? optimisticState
        : urlState,
    setState,
    reset,
  };
}
