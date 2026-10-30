# TanStack Query migration guide — Moosewave Desktop

## Status

- **Phase 1a (shipped, current)** — primitives in `src/lib/query.ts` live; no
  call sites migrated yet.
- **Phase 1b (planned)** — sweep existing `fetch + setState in useEffect`
  call sites onto `useResource` / `useFetch`. Tracked separately.

## Why

The desktop shell has ~80 surfaces that load data on mount via the
classic `useEffect(() => { fetch().then(setState); return cleanup; }, [...])`
pattern. That pattern reliably produces three bug classes:

1. **Race conditions on rapid input** — typing in a search box fires N
   requests; an older slow response can overwrite a newer fast one.
2. **Leaked state updates after unmount** — every site needs the
   `let cancelled = false` boilerplate; missing it shows up as React
   warnings + occasional torn UI.
3. **No cache, no shared state** — Two components needing the same
   payload each re-fetch it. Switching tabs blows away state.

The platform already wires `@tanstack/react-query` (see
`src/lib/query-client.ts`) for the offline-first persistence layer.
Phase 1 just makes the wrappers ergonomic enough that the rest of the
shell can drop the raw `fetch` pattern.

## Primitives

Both hooks live in `src/lib/query.ts` and are typed against the existing
`ApiResult<T>` envelope.

### `useFetch(url, opts?)`

URL-driven. Use when you have a static endpoint and want JSON back.

```tsx
import { useFetch } from "@/lib/query";

function HealthBadge() {
  const { data, error, isLoading } = useFetch<{ status: string }>(
    "/api/health",
  );
  if (isLoading) return <span>...</span>;
  if (error) return <span title={error.message}>down</span>;
  return <span>{data.status}</span>;
}
```

### `useResource(key, fetcher, opts?)`

Keyed; accepts any `(signal) => Promise<T | ApiResult<T>>` fetcher.
This is the form to use with the existing `api.*` methods.

```tsx
import { useResource } from "@/lib/query";
import { qk, STALE } from "@/lib/query-keys";
import { api } from "@/lib/api-client";

function CampaignList({ tenantId, role }: Props) {
  const { data, error, isLoading } = useResource(
    qk.campaigns(tenantId, role, { page: 1 }),
    (signal) => api.listCampaigns({ page: 1 }, { signal }),
    { staleTime: STALE.list },
  );
  // ...
}
```

## What the wrappers give you

| Concern | Raw pattern | `useResource` |
| ------- | ----------- | ------------- |
| AbortController on unmount | manual `cancelled` flag | automatic — signal passed to fetcher |
| Stale-response suppression | none | TanStack mutex + monotonic guard |
| Error envelope normalization | per-site `if (r.error)` | unwrapped into `QueryError` |
| Cache sharing across components | none | TanStack cache, keyed |
| Refetch on focus | manual | off by default (override per query) |
| Loading state | three `useState` calls | `isLoading`/`isFetching` |

## Defaults

The wrappers set:

- `staleTime: 30_000` — 30 s
- `gcTime: 5 * 60_000` — 5 min
- `refetchOnWindowFocus: false`

Override per-call when the resource has a different freshness contract:

```ts
useResource(qk.dashboard(...), fetcher, { staleTime: STALE.dashboard });
```

The global `QueryClient` defaults (in `query-client.ts`) are separately
tuned for offline-first persistence (24 h `gcTime`, focus refetch ON).
The wrappers' tighter defaults apply only to call sites that opt in.

## Error shape

Both hooks reject with `QueryError`, which mirrors `ApiErr.error` shape
so existing renderers keep working:

```ts
class QueryError extends Error {
  status?: number;                                // HTTP status when known
  code?: string;                                  // server-supplied code
  kind?: "http" | "network" | "timeout"
       | "parse" | "invalid_config";
  details?: Record<string, unknown>;              // server-supplied envelope details
}
```

## Migration recipe (for Phase 1b)

Take this site:

```tsx
const [items, setItems] = useState<Foo[] | null>(null);
const [err, setErr] = useState<string | null>(null);
const [loading, setLoading] = useState(true);

useEffect(() => {
  let cancelled = false;
  setLoading(true);
  api.listFoos(params).then((r) => {
    if (cancelled) return;
    if (r.error) setErr(r.error.message);
    else setItems(r.data.items);
    setLoading(false);
  });
  return () => { cancelled = true; };
}, [paramsKey]);
```

Replace with:

```tsx
import { useResource } from "@/lib/query";
import { qk, STALE } from "@/lib/query-keys";

const { data, error, isLoading } = useResource(
  qk.foos(tenantId, role, params),
  (signal) => api.listFoos(params, { signal }),
  { staleTime: STALE.list },
);
const items = data?.items ?? null;
const err = error?.message ?? null;
```

### Migration checklist per site

1. Identify the canonical query key — add it to `query-keys.ts` if
   missing. Always include `tenantId` and `role` so cache is partitioned.
2. Ensure the `api.*` method threads `signal` through to its
   underlying HTTP call. Most already accept `{ signal }` via the
   existing `request<T>` helper.
3. Replace the `useState + useEffect` triple with `useResource(...)`.
4. Drop the `cancelled` cleanup flag, the `setLoading(true/false)` pair,
   and the `r.error` envelope check.
5. If the site mutates the same resource, prefer
   `queryClient.invalidateQueries({ queryKey: qk.foos(...) })` over the
   manual refetch-after-mutate dance.

## When NOT to use these wrappers

- **Server-sent events / WebSockets / streams** — these have their own
  lifecycle. See `sse.ts`.
- **Mutations** — use `useMutation` directly with the canonical
  mutation key from `pending-mutations.ts::mutKey`.
- **One-shot imperative calls** — `api.foo()` from inside an event
  handler. Wrap with `queryClient.fetchQuery` only if you need the
  cache.
- **Tauri command invocations that don't have an HTTP semantics** —
  call `invoke()` directly; there's no cache benefit.

## Reference

- Primitives: `src/lib/query.ts`
- QueryClient + persister: `src/lib/query-client.ts`
- Key factory + STALE table: `src/lib/query-keys.ts`
- Mutation defaults / outbox: `src/lib/outbox.ts`
- Optimistic-UI mutation helpers: `src/lib/pending-mutations.ts`
