/* global jest */

let queryResultOverride;
let queryOptions = [];

function query() {
  return (
    queryResultOverride ?? {
      data: undefined,
      error: null,
      fetchNextPage: jest.fn(async () => undefined),
      hasNextPage: false,
      isError: false,
      isFetching: false,
      isFetchingNextPage: false,
      isLoading: true,
      isPending: true,
      isSuccess: false,
      refetch: jest.fn(async () => ({ data: undefined })),
    }
  );
}

// The LAST options object handed to `useMutation`. A mutation's cache policy —
// which failures mean "our copy is stale, refetch" and which do not — lives
// entirely in `onSuccess`/`onError`, and this mock swallowed it, so nothing
// could ever assert that a 409 refreshes a queue while a 403 does not.
let lastMutationOptions;

function mutation(options) {
  lastMutationOptions = options;
  return {
    data: undefined,
    error: null,
    isError: false,
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(async () => ({})),
    reset: jest.fn(),
    variables: undefined,
  };
}

// Cache entries `getQueriesData` should hand back, as the [key, data] pairs
// TanStack returns. Default empty — the honest "nothing cached" answer.
let cachedQueries = [];
let cachedMutations = [];
const mutationCache = {
  getAll: jest.fn(() => cachedMutations),
  remove: jest.fn(),
};

const client = {
  cancelQueries: jest.fn(async () => undefined),
  getMutationCache: jest.fn(() => mutationCache),
  getQueryData: jest.fn(),
  // Returns [key, data] pairs for every query under a prefix. Used by
  // useCachedRowSeed to read a list row for a detail header; an empty array is
  // the honest "nothing cached" answer, and the hook falls back to its
  // placeholder. Filtered POSITIONALLY, the way TanStack's own partial
  // matching works — a mock that ignored the prefix would let a test pass
  // while the real hook addressed the wrong cache root.
  getQueriesData: jest.fn((filters) => {
    const prefix = filters?.queryKey ?? [];
    return cachedQueries.filter(([key]) =>
      prefix.every((part, i) => Array.isArray(key) && key[i] === part),
    );
  }),
  // What `lib/infiniteQueryRefresh` walks to collapse a paged entry to page one
  // before a pull-to-refresh: every query under a prefix, filtered the same
  // POSITIONAL way, with the state the collapse must preserve. Missing, the
  // refresh handler throws — "the screen crashed", not "the mock is
  // incomplete". The write goes through `setQueryData` below.
  getQueryCache: jest.fn(() => ({
    findAll: (filters) => {
      const prefix = filters?.queryKey ?? [];
      return cachedQueries
        .filter(([key]) =>
          prefix.every((part, i) => Array.isArray(key) && key[i] === part),
        )
        .map(([queryKey, data]) => ({
          queryKey,
          state: { data, dataUpdatedAt: 0, isInvalidated: false },
          invalidate() {},
        }));
    },
  })),
  // The write half of `getQueriesData`, and filtered the same POSITIONAL way.
  // Mutates `cachedQueries` in place so a test can read the result back
  // through `getQueriesData`.
  setQueriesData: jest.fn((filters, updater) => {
    const prefix = filters?.queryKey ?? [];
    const written = [];
    cachedQueries = cachedQueries.map(([key, data]) => {
      const matches = prefix.every(
        (part, i) => Array.isArray(key) && key[i] === part,
      );
      if (!matches) return [key, data];
      const next = typeof updater === "function" ? updater(data) : updater;
      written.push([key, next]);
      return [key, next];
    });
    return written;
  }),
  invalidateQueries: jest.fn(async () => undefined),
  removeQueries: jest.fn(),
  refetchQueries: jest.fn(async () => undefined),
  resetQueries: jest.fn(async () => undefined),
  resumePausedMutations: jest.fn(async () => undefined),
  // Writes ONLY over an entry a test seeded under that exact key, so the
  // collapse can be read back through `__getCachedQueriesForTests`; an
  // undefined value is not a write, as in TanStack. Anything else stays the
  // no-op it always was — those suites assert on the calls, not the cache.
  setQueryData: jest.fn((queryKey, updater) => {
    const at = cachedQueries.findIndex(
      ([key]) =>
        Array.isArray(key) &&
        Array.isArray(queryKey) &&
        key.length === queryKey.length &&
        key.every((part, i) => part === queryKey[i]),
    );
    if (at === -1) return undefined;
    const prev = cachedQueries[at][1];
    const next = typeof updater === "function" ? updater(prev) : updater;
    if (next === undefined) return undefined;
    cachedQueries = cachedQueries.map((entry, i) =>
      i === at ? [entry[0], next] : entry,
    );
    return next;
  }),
};

module.exports = {
  __setQueryResultForTests: (value) => {
    queryResultOverride = value;
  },
  __setCachedQueriesForTests: (entries) => {
    cachedQueries = entries ?? [];
  },
  /** Read the cache back after a `setQueriesData`. */
  __getCachedQueriesForTests: () => cachedQueries,
  __setCachedMutationsForTests: (entries) => {
    cachedMutations = entries ?? [];
  },
  __getMutationCacheForTests: () => mutationCache,
  __resetQueryResultForTests: () => {
    queryResultOverride = undefined;
    lastMutationOptions = undefined;
    cachedQueries = [];
    cachedMutations = [];
    queryOptions = [];
    client.cancelQueries.mockClear();
    client.invalidateQueries.mockClear();
    client.removeQueries.mockClear();
    client.resetQueries.mockClear();
    client.setQueriesData.mockClear();
    mutationCache.getAll.mockClear();
    mutationCache.remove.mockClear();
  },
  __getQueryOptionsForTests: () => queryOptions,
  __getQueryClientForTests: () => client,
  __getLastMutationOptionsForTests: () => lastMutationOptions,
  QueryClient: jest.fn(() => client),
  QueryClientProvider: ({ children }) => children,
  useInfiniteQuery: (options) => {
    queryOptions.push({ kind: "infinite", options });
    return query();
  },
  useMutation: mutation,
  useQuery: (options) => {
    queryOptions.push({ kind: "query", options });
    return query();
  },
  useQueryClient: () => client,
  // The real `focusManager`, minimally. `src/lib/queryFocusGate.ts` reads it at
  // module scope so that the two SSE surfaces only hold a socket while the app
  // is foregrounded (NATIVE#10), which means ANY screen mounting a stream
  // touches it — omitting it here crashed on `.subscribe` rather than failing
  // an assertion. Focused is the honest default for a render test: nothing in
  // this environment ever backgrounds the app, and reporting `false` would put
  // every streaming screen into its paused branch and quietly stop testing the
  // live path. `subscribe` returns the unsubscribe function callers store.
  focusManager: {
    isFocused: () => true,
    setFocused: jest.fn(),
    subscribe: jest.fn(() => () => {}),
  },
};
