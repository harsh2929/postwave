/**
 * TanStack Query primitives for Moosewave Desktop — `useFetch` + `useResource`.
 *
 * ## Migration guide — use this INSTEAD of raw `fetch` + `setState` in load() functions
 *
 * Replace the legacy pattern:
 *
 * ```tsx
 * // BEFORE — raw fetch + setState, no abort, no guard against stale responses.
 * const [data, setData] = useState<Foo | null>(null);
 * const [error, setError] = useState<string | null>(null);
 * const [loading, setLoading] = useState(true);
 * useEffect(() => {
 *   let cancelled = false;
 *   setLoading(true);
 *   fetch("/api/foo")
 *     .then((r) => r.json())
 *     .then((j) => { if (!cancelled) setData(j); })
 *     .catch((e) => { if (!cancelled) setError(String(e)); })
 *     .finally(() => { if (!cancelled) setLoading(false); });
 *   return () => { cancelled = true; };
 * }, []);
 * ```
 *
 * with one of:
 *
 * ```tsx
 * // AFTER — useFetch: URL-driven, the hook owns AbortController + caching.
 * const { data, error, isLoading, refetch } = useFetch<Foo>("/api/foo");
 * ```
 *
 * ```tsx
 * // AFTER — useResource: keyed, accepts the existing api-client method
 * //         (or any (signal) => Promise<T> function).
 * import { api } from "@/lib/api-client";
 * import { qk } from "@/lib/query-keys";
 *
 * const { data, error, isLoading } = useResource(
 *   qk.campaigns(tenantId, role, params),
 *   (signal) => api.listCampaigns(params, { signal }),
 * );
 * ```
 *
 * ### What you get for free
 *  1. **AbortController wiring** — the hook hands the fetcher a `signal`
 *     that's aborted on unmount or key change. No more `cancelled = true`
 *     boilerplate.
 *  2. **Monotonic request guard** — every fetcher invocation tags an
 *     internal counter; only the latest in-flight response is allowed to
 *     resolve the cache. Stale closures from rapid key churn (e.g. typing
 *     in a search box) can't flicker old data into a fresh render.
 *  3. **Error mapping** — both `ApiResult<T>` (Moosewave's
 *     `{ data | error }` envelope) and raw `Response`/network failures
 *     get normalized into a `QueryError` so call sites see one shape.
 *  4. **Sane defaults** — `staleTime: 30s`, `gcTime: 5m`,
 *     `refetchOnWindowFocus: false`. Per-resource overrides should pull
 *     from `STALE` in `query-keys.ts`.
 *
 * ### Defaults rationale
 * Moosewave's global `QueryClient` (see `query-client.ts`) is offline-first
 * with an 8h gcTime matching its encrypted IDB persistence ceiling. These
 * hook-level defaults
 * are deliberately tighter — they apply only to call sites that opt into
 * the wrappers and bias for *freshness* over offline depth, which matches
 * the typical "load some data on mount" pattern these wrappers replace.
 *
 * ### Don't migrate yet
 * Phase 1a (this commit) ships the primitives only. Phase 1b will sweep
 * existing `fetch` + `setState` call sites onto `useResource`. If you're
 * writing NEW code today, prefer these hooks; do NOT bulk-migrate.
 */

import {
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type QueryKey,
  type UseInfiniteQueryOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import type { ApiDenial } from "@postwave/errors";

import type { ApiResult } from "./api-client";

/* ---------- error type ----------------------------------------------- */

/**
 * Normalized error returned by `useFetch` / `useResource`. Combines the
 * three failure modes a call site might encounter:
 *   - HTTP non-2xx (status preserved)
 *   - Network/transport failure (status undefined)
 *   - ApiResult envelope with `error` populated
 *
 * `kind` mirrors `ApiErr.error.kind` so existing error-renderer
 * components keep working.
 */
export class QueryError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly kind?: "http" | "network" | "timeout" | "parse" | "invalid_config";
  readonly details?: Record<string, unknown>;
  /**
   * The server's structured refusal, carried through from `ApiErr.error`.
   *
   * Without it a hook consumer — which is most of the app — could see the
   * explained message but not the class, so it still could not tell a role
   * refusal from a paywall when deciding what button to show.
   */
  readonly denial?: ApiDenial;

  constructor(
    message: string,
    init: {
      status?: number;
      code?: string;
      kind?: QueryError["kind"];
      details?: Record<string, unknown>;
      denial?: ApiDenial;
    } = {},
  ) {
    super(message);
    this.name = "QueryError";
    this.status = init.status;
    this.code = init.code;
    this.kind = init.kind;
    this.details = init.details;
    this.denial = init.denial;
  }
}

/**
 * Lift the discriminated `ApiResult<T>` into a real promise: ok → T,
 * err → throw QueryError. Lets TanStack Query handle retry/cache/error
 * states uniformly across fetcher styles.
 */
export function unwrapApiResult<T>(result: ApiResult<T>): T {
  if (result.error !== undefined) {
    throw new QueryError(result.error.message, {
      status: result.error.status,
      code: result.error.code,
      kind: result.error.kind,
      details: result.error.details,
      denial: result.error.denial,
    });
  }
  return result.data as T;
}

/* ---------- monotonic guard ------------------------------------------ */

/**
 * Counter ref per hook instance. Each fetcher call bumps the counter and
 * captures the value; only the latest call is allowed to influence the
 * cache. TanStack already handles stale-response suppression via its own
 * query-mutex, but the explicit guard catches a narrower hazard: a
 * fetcher that DOESN'T honor `signal` (e.g. wraps a third-party SDK
 * call) — without the guard, a slow earlier call could resolve AFTER a
 * faster later one and overwrite fresh data with stale data.
 */
function useMonotonicGuard(): { next: () => number; current: () => number } {
  const ref = useRef(0);
  return useMemo(
    () => ({
      next: (): number => {
        ref.current += 1;
        return ref.current;
      },
      current: (): number => ref.current,
    }),
    [],
  );
}

/* ---------- defaults ------------------------------------------------- */

const DEFAULTS = {
  staleTime: 30_000,           // 30s
  gcTime: 5 * 60_000,          // 5m
  refetchOnWindowFocus: false, // bias for freshness on demand, not on focus
} as const;

/* ---------- useFetch ------------------------------------------------- */

export interface UseFetchOptions<T>
  extends Omit<
    UseQueryOptions<T, QueryError, T, QueryKey>,
    "queryKey" | "queryFn"
  > {
  /** Extra fetch init forwarded to the underlying `fetch()` call. */
  init?: Omit<RequestInit, "signal">;
  /**
   * Custom parser. Defaults to `res.json()` typed as `T`. Use this when
   * the endpoint returns text/CSV/Blob.
   */
  parse?: (res: Response) => Promise<T>;
  /**
   * Override the query key. Defaults to `["fetch", url, init?.method]`
   * — sufficient for most static URLs. Pass a richer key (e.g. include
   * query-string params) when the URL alone isn't unique.
   */
  queryKey?: QueryKey;
}

/**
 * Drop-in replacement for `fetch().then(setState)` patterns.
 *
 * Example:
 *   const { data, isLoading, error } = useFetch<Health>("/api/health");
 */
export function useFetch<T = unknown>(
  url: string,
  opts: UseFetchOptions<T> = {},
) {
  const guard = useMonotonicGuard();
  const { init, parse, queryKey, ...rest } = opts;
  const key: QueryKey = queryKey ?? ["fetch", url, init?.method ?? "GET"];

  return useQuery<T, QueryError, T, QueryKey>({
    ...DEFAULTS,
    ...rest,
    queryKey: key,
    queryFn: async ({ signal }): Promise<T> => {
      const tag = guard.next();
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal });
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          // TanStack swallows AbortError into the cache as a non-result;
          // re-throw so its internals route correctly.
          throw e;
        }
        throw new QueryError(
          e instanceof Error ? e.message : "network error",
          { kind: "network" },
        );
      }
      if (!res.ok) {
        let body = "";
        try {
          body = (await res.text()).slice(0, 2048);
        } catch {
          /* ignore */
        }
        throw new QueryError(
          body || `HTTP ${res.status}`,
          { status: res.status, kind: "http" },
        );
      }
      let parsed: T;
      try {
        parsed = parse
          ? await parse(res)
          : ((await res.json()) as T);
      } catch (e) {
        throw new QueryError(
          e instanceof Error ? e.message : "parse error",
          { kind: "parse" },
        );
      }
      // Monotonic guard — if a newer fetch superseded this one, discard
      // the result by throwing AbortError (TanStack treats it as a
      // benign cancellation, leaving the prior data intact).
      if (tag !== guard.current()) {
        throw new DOMException("Superseded by newer request", "AbortError");
      }
      return parsed;
    },
  });
}

/* ---------- useResource ---------------------------------------------- */

/**
 * Fetcher signature accepted by `useResource`. The fetcher receives an
 * `AbortSignal` it MUST forward to whatever transport it uses (fetch,
 * api-client, custom SDK). Returning either a raw `T` or the Moosewave
 * `ApiResult<T>` envelope is supported — the wrapper unwraps either.
 */
export type ResourceFetcher<T> = (
  signal: AbortSignal,
) => Promise<T | ApiResult<T>>;

export interface UseResourceOptions<T>
  extends Omit<
    UseQueryOptions<T, QueryError, T, QueryKey>,
    "queryKey" | "queryFn"
  > {}

/**
 * Keyed resource hook. Use when the caller already has a fetcher
 * function (typically `api.fooBar(...)`) and a canonical query key from
 * `query-keys.ts`.
 *
 * Example:
 *   const { data, error } = useResource(
 *     qk.campaigns(tenantId, role, params),
 *     (signal) => api.listCampaigns(params, { signal }),
 *     { staleTime: STALE.list },
 *   );
 */
export function useResource<T>(
  key: QueryKey,
  fetcher: ResourceFetcher<T>,
  opts: UseResourceOptions<T> = {},
) {
  const guard = useMonotonicGuard();

  return useQuery<T, QueryError, T, QueryKey>({
    ...DEFAULTS,
    ...opts,
    queryKey: key,
    queryFn: async ({ signal }): Promise<T> => {
      const tag = guard.next();
      let raw: T | ApiResult<T>;
      try {
        raw = await fetcher(signal);
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") throw e;
        if (e instanceof QueryError) throw e;
        throw new QueryError(
          e instanceof Error ? e.message : "fetcher failed",
          { kind: "network" },
        );
      }
      // Monotonic guard before unwrap so we don't surface an error from
      // a superseded call (which the caller will never see anyway, but
      // would otherwise show up in retry counts).
      if (tag !== guard.current()) {
        throw new DOMException("Superseded by newer request", "AbortError");
      }
      // Distinguish ApiResult envelope ({ data } | { error }) from a raw
      // T by structural-typing it. ApiResult<T> always has EITHER `data`
      // or `error` keys, never both, and always with `error` defined for
      // failures. A raw T may coincidentally have a `data` key, so we
      // require BOTH the shape AND that the value is an object literal
      // with no other typical T shape signal — when in doubt, prefer
      // treating it as raw T so callers control the envelope contract.
      if (isApiResultShape(raw)) {
        return unwrapApiResult(raw);
      }
      return raw as T;
    },
  });
}

/**
 * Heuristic: an object with exactly one of {data, error} populated, and
 * the rest of its keys absent, is treated as `ApiResult<T>`. A raw T can
 * still slip through if it happens to match — callers in that edge case
 * should wrap their result manually. Exported for unit tests; not part
 * of the public hook surface.
 */
export function isApiResultShape(v: unknown): v is ApiResult<unknown> {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  const hasData = "data" in obj;
  const hasError = "error" in obj;
  if (hasError && obj.error !== undefined) {
    const err = obj.error;
    return (
      typeof err === "object" &&
      err !== null &&
      typeof (err as { message?: unknown }).message === "string"
    );
  }
  if (hasData && !hasError) {
    // Only treat as envelope if `data` is the only meaningful key.
    // Conservatively require object.keys(obj).length === 1 so we don't
    // misclassify a raw T like { data: ..., id: ... }.
    return Object.keys(obj).length === 1;
  }
  return false;
}

/* ---------- useInfiniteList ------------------------------------------ */

/**
 * Page payload returned by a `useInfiniteList` fetcher. The hook treats
 * a page as "the last one" when:
 *   - `nextPage === null` is explicitly returned, OR
 *   - the helper infers `items.length < perPage` (heuristic for endpoints
 *     that don't surface a `next` cursor but do honour `perPage`).
 *
 * `total` is optional — when present, the page header can render an
 * accurate "Showing N of M" subtitle; otherwise we fall back to the
 * honest "Showing N items" copy.
 */
export interface InfiniteListPage<T> {
  items: T[];
  nextPage?: number | null;
  total?: number;
}

export type InfiniteListFetcher<T> = (
  ctx: { pageParam: number; signal: AbortSignal },
) => Promise<InfiniteListPage<T>>;

export interface UseInfiniteListOptions<T>
  extends Omit<
    UseInfiniteQueryOptions<
      InfiniteListPage<T>,
      QueryError,
      InfiniteData<InfiniteListPage<T>>,
      QueryKey,
      number
    >,
    "queryKey" | "queryFn" | "initialPageParam" | "getNextPageParam"
  > {
  /** Page size used by the fetcher. Defaults to 25 — matches the
   *  legacy client-side `PAGE_SIZE` the list pages were using. */
  perPage?: number;
  /** First page number. Most Moosewave list endpoints are 1-indexed; we
   *  default accordingly. Cursor-style backends can override to `0`. */
  initialPage?: number;
}

/**
 * Server-driven "Load more" pagination on top of TanStack
 * `useInfiniteQuery`. Designed for the 6 list pages migrated in Phase 1
 * away from client-side `.slice()`-based "Page X of Y" controls.
 *
 * The hook owns:
 *   - `pageParam` plumbing (next page = current + 1).
 *   - `hasNextPage` inference — honours explicit `nextPage` from the
 *     fetcher OR falls back to a length-based heuristic.
 *   - A flat `items` selector so call sites can render
 *     `data.items.map(...)` instead of walking `pages[].items[]`.
 *
 * Example:
 *   const q = useInfiniteList(
 *     qk.campaigns(tenantId, role, { filter, query }),
 *     async ({ pageParam, signal }) => {
 *       const res = await api.listCampaigns({
 *         page: pageParam,
 *         perPage: 25,
 *       }, { signal });
 *       if (res.error) throw new QueryError(res.error.message);
 *       const items = res.data?.items ?? res.data?.results ?? [];
 *       return { items, total: res.data?.total };
 *     },
 *     { perPage: 25, staleTime: STALE.list },
 *   );
 *
 *   <button
 *     disabled={!q.hasNextPage || q.isFetchingNextPage}
 *     onClick={() => q.fetchNextPage()}>
 *     {q.isFetchingNextPage ? "Loading…" : "Load more"}
 *   </button>
 */
export function useInfiniteList<T>(
  key: QueryKey,
  fetcher: InfiniteListFetcher<T>,
  opts: UseInfiniteListOptions<T> = {},
) {
  const guard = useMonotonicGuard();
  const { perPage = 25, initialPage = 1, ...rest } = opts;

  const query = useInfiniteQuery<
    InfiniteListPage<T>,
    QueryError,
    InfiniteData<InfiniteListPage<T>>,
    QueryKey,
    number
  >({
    ...DEFAULTS,
    ...rest,
    queryKey: key,
    initialPageParam: initialPage,
    queryFn: async ({ pageParam, signal }) => {
      const tag = guard.next();
      let page: InfiniteListPage<T>;
      try {
        page = await fetcher({ pageParam, signal });
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") throw e;
        if (e instanceof QueryError) throw e;
        throw new QueryError(
          e instanceof Error ? e.message : "fetcher failed",
          { kind: "network" },
        );
      }
      if (tag !== guard.current()) {
        throw new DOMException("Superseded by newer request", "AbortError");
      }
      return page;
    },
    getNextPageParam: (
      lastPage: InfiniteListPage<T>,
      _all,
      lastPageParam: number,
    ): number | null => {
      // Explicit `null` from the server wins — it means "we know this is
      // the last page, don't ask again."
      if (lastPage.nextPage === null) return null;
      if (typeof lastPage.nextPage === "number") return lastPage.nextPage;
      // Heuristic: a short page (< perPage rows) means we've hit the end.
      // This covers backends that don't return a cursor but honour
      // `perPage` — every Moosewave list endpoint behaves this way today.
      if (lastPage.items.length < perPage) return null;
      return lastPageParam + 1;
    },
  });

  /** Flat array view across all loaded pages. Memoised on the cached
   *  pages array reference so consumers can `.map` it without rebuilding
   *  on every render. */
  const items = useMemo<T[]>(
    () => (query.data?.pages ?? []).flatMap((p) => p.items),
    [query.data],
  );

  /** Total reported by the most recent page, if the endpoint surfaces
   *  one. Useful for "Showing N of M" subtitles. */
  const total = useMemo<number | undefined>(() => {
    const pages = query.data?.pages;
    if (!pages || pages.length === 0) return undefined;
    return pages[pages.length - 1]!.total;
  }, [query.data]);

  return {
    ...query,
    items,
    total,
    /** Number of rows currently visible to the user. Always derived from
     *  `items.length` so it stays honest when filters/sorts are server-
     *  side (the cache invalidates on key change). */
    loadedCount: items.length,
  };
}
