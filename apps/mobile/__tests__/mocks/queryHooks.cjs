/* global jest */

function query() {
  return {
    data: undefined,
    error: null,
    fetchNextPage: jest.fn(async () => undefined),
    hasNextPage: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: true,
    isPending: true,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

function mutation() {
  return {
    data: undefined,
    error: null,
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(async () => ({})),
    reset: jest.fn(),
    variables: undefined,
  };
}

const OPEN_GATE = {
  enabled: true,
  baseUrl: "https://api.postwave.test",
  canReadOfflineSnapshots: true,
  credentialScope: "session",
  effectiveRole: "owner",
  hasAuthenticatedIdentity: true,
  isOnline: true,
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
};

// Screens must render a cached-session notice — never a manufactured negative
// claim about tenant state — while the online gate is closed. That branch is
// unreachable in a route test unless the gate can be closed, so tests may
// override it. Always restored via __resetOnlineGateForTests in afterEach.
let gateOverride;
// OS reachability, separate from the auth gate: in api_key mode
// `canUseOnlineServices()` never consults the network, so screens that refuse
// a write with no connection read `useIsOnline()` instead. Defaults to true;
// tests that exercise the offline-refusal branch flip it and reset it.
let isOnlineOverride;
// Per-hook query-result overrides, keyed by hook name (e.g. useVoiceProfile),
// so a screen's loaded branch can be exercised without every mocked hook in
// the file returning the same payload.
const hookResults = new Map();
const hookCalls = new Map();

module.exports = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === "__esModule") return true;
      if (property === "__setOnlineGateForTests") {
        return (value) => {
          gateOverride = { ...OPEN_GATE, ...value };
        };
      }
      if (property === "__resetOnlineGateForTests") {
        return () => {
          gateOverride = undefined;
          isOnlineOverride = undefined;
        };
      }
      if (property === "__setIsOnlineForTests") {
        return (value) => {
          isOnlineOverride = value;
        };
      }
      if (property === "__setHookResultForTests") {
        return (name, value) => hookResults.set(name, value);
      }
      if (property === "__resetHookResultsForTests") {
        return () => {
          hookResults.clear();
          hookCalls.clear();
        };
      }
      if (property === "__getHookCallsForTests") {
        return (name) => hookCalls.get(name) ?? [];
      }
      if (hookResults.has(property)) {
        const value = hookResults.get(property);
        return (...args) => {
          const calls = hookCalls.get(property) ?? [];
          calls.push(args);
          hookCalls.set(property, calls);
          return value;
        };
      }
      if (property === "useDebounced") return (value) => value;
      if (property === "useIsOnline") {
        return () => (isOnlineOverride === undefined ? true : isOnlineOverride);
      }
      if (property === "useOnlineQueryGate") {
        return () => gateOverride ?? OPEN_GATE;
      }
      if (property === "onlineQueryAuthorityOwner") {
        return (gate) =>
          JSON.stringify([
            gate.baseUrl ?? "origin-unresolved",
            gate.tenantId ?? "tenant-unresolved",
            gate.userId ?? "user-anonymous",
            gate.effectiveRole ?? "role-unresolved",
            gate.credentialScope,
          ]);
      }
      if (property === "canRunOnlineOrSnapshotQuery") {
        return (gate) => gate.enabled || gate.canReadOfflineSnapshots;
      }
      if (property === "useRetentionOffersAccess") {
        return () => {
          const gate = gateOverride ?? OPEN_GATE;
          const authorized =
            gate.tenantId === "11111111-1111-4111-8111-111111111111" &&
            (gate.effectiveRole === "owner" || gate.effectiveRole === "admin");
          return {
            gate,
            identity: {
              gateEnabled: gate.enabled,
              tenantId: gate.tenantId,
              userId: gate.userId,
              effectiveRole: gate.effectiveRole,
              mode: "session",
              viewerMode: false,
            },
            mode: "session",
            viewerMode: false,
            authorized,
            allowed: authorized && gate.enabled,
          };
        };
      }
      // CONSTANTS, not hooks. The proxy answers `undefined` for anything not
      // starting with "use", so the approvals screen's truncation notice threw
      // on `limit.toLocaleString()` the moment a test rendered a loaded queue.
      if (property === "APPROVALS_PAGE_LIMIT") return 100;
      if (property === "escalationHint") return () => null;
      if (property === "usePendingApprovalsCount") return () => 0;
      // Returns a SCALAR (number | null), not a query object. Without this it
      // fell through to the `use*` query fallback and the dashboard published
      // a query result to the widget mirror instead of a count.
      if (property === "usePendingApprovalsPublishable") return () => 0;
      // `useBuild*` is a mutation, not a query. Returning the query shape gave
      // it isPending: true forever, so any screen driving a button label off
      // it rendered a permanently "Starting…" control in every route test.
      // `useTransition*` is a mutation for the same reason: the breach-register
      // sheet drives its state buttons off `isPending`, so the query shape's
      // permanent `isPending: true` disabled every transition control and hid
      // the assertions about which ones are offered.
      // `useApply*` joins the list for the same reason: both hooks with that
      // prefix (useApplyDefaultUtm, useApplyDuplicateMerge) are mutations, and
      // the query shape's permanent `isPending: true` disabled the duplicate
      // queue's merge button in every test that had not explicitly overridden
      // it — so the confirmation sheet could never open and the assertions
      // about what it SAYS passed only where the mutation was mocked by hand.
      // `useSave<Thing>` joins it too: useSaveBrandVoiceProfile is a mutation,
      // and the query shape left the brand-voice editor's Save reading
      // "Saving…", disabled, in every route test. A capital must follow, so
      // the `useSaved*` QUERIES (useSavedSegments, useSavedReportRuns, …) stay
      // queries. Every useMutation export of a module the mapper proxies must
      // match an arm here; query-hooks-proxy-shape.native.test.ts enforces it.
      if (
        property === "useApprovalDecision" ||
        /^useSave[A-Z]/u.test(String(property)) ||
        String(property).startsWith("useApply") ||
        String(property).startsWith("useBuild") ||
        String(property).startsWith("useUpdate") ||
        String(property).startsWith("useSet") ||
        String(property).startsWith("useSuppress") ||
        String(property).startsWith("useVerify") ||
        String(property).startsWith("useResend") ||
        String(property).startsWith("useTransition") ||
        String(property).startsWith("usePause") ||
        String(property).startsWith("useCampaignLifecycle")
      ) {
        return mutation;
      }
      // Pure scope predicates, not hooks — so the `use*` fallthrough below
      // never sees them and they would otherwise resolve to `undefined` and
      // blow up at the call site. Both mirror the real "absent scopes" answer:
      // null = "not known yet" (the screen must not render a verdict it has
      // not received), false = "no un-masked PII".
      if (property === "hasAuditReadScope") return () => null;
      if (property === "hasAuditPiiScope") return () => false;
      // Builds a Map keyed by audit id; an empty one is the honest answer for
      // the mocked "no rows loaded" state, and the screen calls `.get` on it.
      if (property === "anomalyIndex") return () => new Map();
      // Returns a RESOLVED CONTEXT OBJECT, not a query and not undefined:
      // the approval detail screen reads `context.title` during render, so an
      // undefined here crashed every loaded-state assertion on that screen and
      // hid the fact that nothing had ever exercised it.
      if (property === "useApprovalResourceContext")
        return () => ({ loading: false });
      if (property === "approvalDecisionSuccessMessage") return () => "Updated";
      if (property === "decisionErrorMessage") return () => "Request failed";
      if (property === "campaignLifecycleActions") return () => [];
      if (property === "isDraftCampaignStatus") return () => false;
      if (property === "resendSummaryMessage") return () => "Queued";
      if (property === "nextTagsAfterRemove")
        return (tags = [], removed) => tags.filter((tag) => tag !== removed);
      // Its pair. Missing here, so the UNDO offered inside the tag-removal
      // toast — which recomputes the full-array-replace payload with it —
      // threw "not a function" the moment a test pressed it, which is why
      // nothing had ever exercised that branch.
      if (property === "nextTagsAfterAdd")
        return (tags = [], added) =>
          tags.some(
            (tag) => tag.trim().toLowerCase() === added.trim().toLowerCase(),
          )
            ? null
            : [...tags, added];
      if (property === "subscriberTimelineKey")
        return (...parts) => ["subscriber-timeline", ...parts];
      if (String(property).startsWith("use")) return query;
      return undefined;
    },
  },
);
