// The mutation cache is real API surface, not a detail: the offline-queue
// inspector and the offline banner both SUBSCRIBE to it on mount, so a mock
// without it turns "does this screen render" into an unrelated TypeError.
const mutationCache = {
  getAll: jest.fn(() => []),
  subscribe: jest.fn(() => jest.fn()),
  remove: jest.fn(),
};

const queryClient = {
  resumePausedMutations: jest.fn(async () => undefined),
  getMutationCache: jest.fn(() => mutationCache),
};

module.exports = new Proxy(
  {
    EVENTS: new Proxy({}, { get: (_target, property) => String(property) }),
    // Read as a TABLE, not called: `mutationKey: OFFLINE_MUTATION_KEYS.campaignUpdate`.
    // The catch-all below answers an unknown property with a jest.fn(), and a
    // function has no `.campaignUpdate` — so any component reaching an
    // offline-safe mutation threw on render rather than failing an assertion.
    OFFLINE_MUTATION_KEYS: new Proxy(
      {},
      { get: (_target, property) => [String(property)] },
    ),
    // Spread into `meta:`, so it has to be an object for the same reason.
    offlineSafeMutationMeta: {},
    planDeepLinkNavigation: () => ({ kind: "ignore" }),
    queryClient,
    queryPersistOptions: {},
  },
  {
    get(target, property) {
      if (property in target) return target[property];
      if (property === "configureMobileConnectivity") return () => jest.fn();
      if (property === "configureQueryPersistenceScope") return () => null;
      if (property === "startEventCacheSync") return () => jest.fn();
      if (String(property).startsWith("take")) return async () => null;
      if (String(property).startsWith("parse") || String(property).startsWith("plan") || String(property).startsWith("route")) return () => null;
      if (String(property).startsWith("get")) return async () => false;
      return jest.fn(async () => undefined);
    },
  },
);
