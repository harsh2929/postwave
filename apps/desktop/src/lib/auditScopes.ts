/**
 * rbac-meta-audit — shared hook + helpers for the audit:* scope set.
 *
 * The Audit page, Sidebar, AuditSinks page, and the Settings > Team >
 * Roles matrix all need to know the current actor's effective audit
 * scopes. We fetch once at module-level and share via a tiny pub-sub
 * so multiple subscribers don't each hit /audit/my-scopes on mount.
 *
 * ScopeAdmin (the literal `admin` scope carried by legacy/API-key
 * principals) acts as a wildcard. The response's `isAdmin` presentation flag
 * does not: an administrator can have an audit grant removed, and an
 * arbitrary truthy wire value must never manufacture permissions.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { type MyAuditScopesResponse, api } from "./api-client";
import { decodeMyAuditScopesPayload } from "./api/audit-operations";
import { onContextEpochChange, readContextEpoch } from "./context-epoch";
import { desktopRouteIdentityScope } from "./desktop-route-runtime";
import { useMe } from "./store";

export type AuditScopeName =
  | "audit:read"
  | "audit:read_pii"
  | "audit:read_all_tenants"
  | "audit:configure_sinks"
  | "audit:configure_retention"
  | "audit:execute_actions";

interface ScopeState {
  loading: boolean;
  scopes: Set<string>;
  isAdmin: boolean;
  error: string | null;
}

function initialScopeState(): ScopeState {
  return {
    loading: true,
    scopes: new Set(),
    isAdmin: false,
    error: null,
  };
}

interface ScopeBucket {
  state: ScopeState;
  generation: number;
  inflight: Promise<void> | null;
  subscribers: Set<(state: ScopeState) => void>;
}

const LEGACY_SCOPE_KEY = "__unresolved__";
const buckets = new Map<string, ScopeBucket>();
let activeIdentityScope: string | null = null;

function bucketFor(identityScope: string | null): ScopeBucket {
  const key = identityScope ?? LEGACY_SCOPE_KEY;
  const existing = buckets.get(key);
  if (existing) return existing;
  const created: ScopeBucket = {
    state: initialScopeState(),
    generation: 0,
    inflight: null,
    subscribers: new Set(),
  };
  buckets.set(key, created);
  return created;
}

function emit(bucket: ScopeBucket): void {
  for (const subscriber of bucket.subscribers) subscriber(bucket.state);
}

function setState(bucket: ScopeBucket, next: ScopeState): void {
  bucket.state = next;
  emit(bucket);
}

async function fetchOnce(identityScope: string): Promise<void> {
  const bucket = bucketFor(identityScope);
  if (bucket.inflight) return bucket.inflight;
  const generation = bucket.generation;
  const request = (async () => {
    try {
      const res = await api.getMyAuditScopes();
      if (bucket.generation !== generation) return;
      if (res.error || !res.data) {
        // Fail CLOSED: grant nothing on a fetch failure. The UI shows
        // the blocked state (with the error) and the operator can
        // refresh; self-granting audit:read here let a transient error
        // unlock UI surfaces the actor may not actually hold.
        setState(bucket, {
          loading: false,
          scopes: new Set(),
          isAdmin: false,
          error: res.error?.message ?? "couldn't load scopes",
        });
        return;
      }
      // Decode defensively even though the API facade also decodes. Tests,
      // alternate transports, and older callers can provide the facade
      // directly; this hook is the final permission boundary before UI mount.
      const r: MyAuditScopesResponse | null = decodeMyAuditScopesPayload(
        res.data,
      );
      if (!r) {
        setState(bucket, {
          loading: false,
          scopes: new Set(),
          isAdmin: false,
          error: "the permission response was invalid",
        });
        return;
      }
      const all = new Set<string>([...r.scopes, ...r.auditScopes]);
      setState(bucket, {
        loading: false,
        scopes: all,
        isAdmin: r.isAdmin,
        error: null,
      });
    } catch {
      if (bucket.generation !== generation) return;
      setState(bucket, {
        loading: false,
        scopes: new Set(),
        isAdmin: false,
        error: "couldn't load scopes",
      });
    } finally {
      if (bucket.generation === generation) bucket.inflight = null;
    }
  })();
  bucket.inflight = request;
  return request;
}

/** Hook returns the actor's audit scope state. Components re-render
 *  whenever the cache is refreshed (e.g. after assignRoleScopes). */
export function useAuditScopes(): ScopeState & {
  hasScope: (s: AuditScopeName) => boolean;
  refresh: () => Promise<void>;
} {
  const me = useMe();
  // Audit grants belong to the effective authorization context, not merely
  // the durable user/tenant identity. View-as-Viewer changes effectiveRole
  // without changing either ID, and a context-epoch change can represent a
  // same-role grant edit. Both must force a fresh fail-closed resolution.
  const contextEpoch = useSyncExternalStore(
    onContextEpochChange,
    readContextEpoch,
    readContextEpoch,
  );
  const durableIdentityScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  const identityScope = durableIdentityScope
    ? `${durableIdentityScope}:${me?.effectiveRole ?? "unresolved"}:${contextEpoch ?? "unobserved"}`
    : null;
  const bucket = useMemo(() => bucketFor(identityScope), [identityScope]);
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      const subscriber = (): void => onStoreChange();
      bucket.subscribers.add(subscriber);
      return () => bucket.subscribers.delete(subscriber);
    },
    [bucket],
  );
  const getSnapshot = useCallback(() => bucket.state, [bucket]);
  const cachedState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const state =
    activeIdentityScope === identityScope ? cachedState : initialScopeState();
  useEffect(() => {
    if (activeIdentityScope !== identityScope) {
      activeIdentityScope = identityScope;
      for (const [key, previousBucket] of buckets) {
        if (key === (identityScope ?? LEGACY_SCOPE_KEY)) continue;
        // Invalidate the detached generation before deleting the bucket. A
        // late response may still hold this object even though it is no longer
        // addressable from the cache; bumping the generation ensures it cannot
        // publish a prior identity's grants to a subscriber during cleanup.
        previousBucket.generation += 1;
        previousBucket.inflight = null;
        previousBucket.state = initialScopeState();
        emit(previousBucket);
        buckets.delete(key);
      }
      bucket.generation += 1;
      bucket.inflight = null;
      setState(bucket, initialScopeState());
    }
    if (identityScope && bucket.state.loading && !bucket.inflight) {
      void fetchOnce(identityScope);
    }
  }, [bucket, identityScope]);
  return {
    ...state,
    hasScope: (s: AuditScopeName): boolean => {
      return state.scopes.has("admin") || state.scopes.has(s);
    },
    refresh: () => {
      bucket.generation += 1;
      bucket.inflight = null;
      setState(bucket, initialScopeState());
      return identityScope ? fetchOnce(identityScope) : Promise.resolve();
    },
  };
}

/** Imperative variant for code paths that don't have a hook context
 *  (older class components, event handlers). Returns the current
 *  cached snapshot; the result reflects whatever the last fetchOnce
 *  resolved to. */
export function getAuditScopesSnapshot(): ScopeState {
  return bucketFor(activeIdentityScope).state;
}

/** Reset for tests so a fresh fetch happens on next read. */
export function resetAuditScopesCacheForTests(): void {
  buckets.clear();
  activeIdentityScope = null;
}
