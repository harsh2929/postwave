/**
 * API keys — the render contract for the screen that kills a leaked key.
 *
 * WHY THIS FILE EXISTS. `app/(tabs)/api-keys.tsx` shipped with policy tests for
 * its pure helpers (`lib/apiKeyRows.test.ts` covers order, state precedence and
 * risk) and NO render test: nothing had ever mounted the screen. Policy tests
 * prove the ordering and the labels are right; they cannot prove the screen
 * survives being opened.
 *
 * That distinction has already cost this programme a screen. `MaintenanceBanner`
 * shipped the same way — 31 policy tests, no render test — and crashed the whole
 * dashboard with "windows.find is not a function" the first time a query handed
 * it something other than an array.
 *
 * The screen is driven through the route component rather than a leaf, which is
 * safe HERE and only here: `api-keys.tsx` has exactly ONE `useQuery` in its
 * graph (`useApiKeys`; the revoke is a `useMutation`). The `@tanstack/react-query`
 * harness sets one result for EVERY `useQuery` in the module graph, so a screen
 * with several distinct reads would get the same payload for all of them — which
 * is how a suite passes while asserting nothing.
 *
 * WHAT THIS PROTECTS. Every assertion is about a WRONG SENTENCE or a crash, not
 * about a blank screen:
 *
 *   - "No API keys / Nothing can reach this workspace through the API" rendered
 *     because a GET failed is the most damaging string this screen owns. It tells
 *     someone hunting a leak that there is no leak, and the ladder that prevents
 *     it (`QueryStates`) is one collapsed branch away.
 *   - The same copy shown OFFLINE would be a second lie on top of the first: the
 *     revoke button on this screen cannot reach the server at all, and the
 *     operator must be told that rather than shown an empty roster.
 *   - The subtitle is the one number the screen exists to make honest — how many
 *     keys can still reach the workspace. Counting a revoked key would overstate
 *     it; printing "0 active keys" before the fetch resolves would claim the
 *     workspace is sealed when nothing is known yet.
 *   - A revoked key must not be offered a Revoke, because that action can only
 *     no-op on an already-dead key.
 *
 * There is deliberately no admin-vs-viewer assertion here: unlike
 * `agent-mandates`, this route carries `minimumRole: "admin"` in
 * `lib/mobileRoutesAdmin.ts`, so the nav row never reaches a viewer and the
 * screen gates nothing in place. Asserting a role split would be asserting a
 * behaviour the screen does not have.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";

import ApiKeys from "../app/(tabs)/api-keys";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

const hookHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  hookHarness.__resetOnlineGateForTests();
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A row in the shape `api/apiKeys.ts#normalizeKey` produces — camelCase, not the
 * wire's snake_case, because the hook hands the screen the PARSED shape. Feeding
 * a raw wire row here would test a shape the screen never sees.
 */
function key(overrides: Record<string, unknown> = {}) {
  return {
    id: "k-live-1",
    label: "CI deploy key",
    prefix: "pw_live_9f2c",
    scopes: ["write:subscribers", "read:campaigns"],
    createdAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    lastUsedAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    actorType: "human",
    sandboxOnly: false,
    ...overrides,
  };
}

function settled(value: unknown) {
  return {
    data: value,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: value })),
  };
}

function failed() {
  return {
    data: undefined,
    error: new Error("upstream unavailable"),
    isError: true,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: false,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

/** First load, nothing resolved yet. */
function loading() {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: true,
    isLoading: true,
    isPending: true,
    isRefetching: false,
    isSuccess: false,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

/**
 * The gate-closed shape TanStack actually produces: a disabled query is
 * `pending` but NOT fetching, so `isLoading` is false and the skeleton branch is
 * not the one that runs.
 */
function gatedOff() {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: true,
    isRefetching: false,
    isSuccess: false,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

function online() {
  hookHarness.__setOnlineGateForTests({
    enabled: true,
    tenantId: "t1",
    effectiveRole: "admin",
    online: true,
  });
}

function offline() {
  hookHarness.__setOnlineGateForTests({
    enabled: false,
    tenantId: "t1",
    effectiveRole: "admin",
    online: false,
  });
}

describe("api keys render contract", () => {
  it("mounts at all", async () => {
    // The assertion the whole file is really for: before this, nothing had ever
    // rendered this screen.
    online();
    queryHarness.__setQueryResultForTests(settled([key()]));
    await render(<ApiKeys />, { wrapper });
    expect(screen.getByText("API keys")).toBeTruthy();
  });

  it("renders the key's label, its prefix and what it can do", async () => {
    // The prefix is the ONLY part of the key the server ever shows again, and
    // the screen's revoke gate makes you type it — so a row that dropped it
    // would make the emergency action unperformable.
    online();
    queryHarness.__setQueryResultForTests(settled([key()]));
    await render(<ApiKeys />, { wrapper });
    expect(screen.getByText("CI deploy key")).toBeTruthy();
    expect(screen.getByText("pw_live_9f2c")).toBeTruthy();
    expect(screen.getByText("write:subscribers, read:campaigns")).toBeTruthy();
    expect(screen.getByText("live")).toBeTruthy();
  });

  it("counts only keys that have not been revoked", async () => {
    // The single number this screen exists to make honest: how much can still
    // reach the workspace. Counting the key you just killed would overstate it.
    online();
    queryHarness.__setQueryResultForTests(
      settled([
        key(),
        key({
          id: "k-dead-1",
          label: "Leaked laptop key",
          revokedAt: new Date(Date.now() - DAY_MS).toISOString(),
        }),
      ]),
    );
    await render(<ApiKeys />, { wrapper });
    expect(screen.getByText("1 active key")).toBeTruthy();
  });

  it("claims no count at all until the list has loaded", async () => {
    // "0 active keys" during the first fetch says the workspace is sealed. The
    // screen guards the subtitle on `data !== undefined` precisely for this, and
    // that guard is invisible to every policy test.
    online();
    queryHarness.__setQueryResultForTests(loading());
    await render(<ApiKeys />, { wrapper });
    expect(screen.getByText("API keys")).toBeTruthy();
    expect(screen.queryByText(/active key/u)).toBeNull();
  });

  it("does not tell a failed fetch that nothing can reach the workspace", async () => {
    // The damaging lie. Someone opening this screen at 2am is looking for a
    // leaked key; "Nothing can reach this workspace through the API" because a
    // GET 500'd sends them back to bed.
    online();
    queryHarness.__setQueryResultForTests(failed());
    await render(<ApiKeys />, { wrapper });
    // Positive assertion first, so the two negatives below cannot pass merely
    // because this branch rendered nothing at all.
    expect(screen.getByText("Try again")).toBeTruthy();
    expect(screen.queryByText("No API keys")).toBeNull();
    expect(screen.queryByText(/Nothing can reach this workspace/u)).toBeNull();
    // And no count either: "0 active keys" beside an error is the same claim in
    // fewer words.
    expect(screen.queryByText(/active key/u)).toBeNull();
  });

  it("tells an offline operator the revoke would not reach the server", async () => {
    // Worse than an empty roster here: revoke is online-only and never queued,
    // so silence would let the operator believe a leaked key is now dead.
    offline();
    queryHarness.__setQueryResultForTests(gatedOff());
    await render(<ApiKeys />, { wrapper });
    expect(screen.getByText(/would not reach the server/u)).toBeTruthy();
    expect(screen.queryByText("No API keys")).toBeNull();
    expect(screen.queryByText(/Nothing can reach this workspace/u)).toBeNull();
  });

  it("says 'No API keys' only when the fetch really returned none", async () => {
    // The same words the two tests above forbid, reached by the one route that
    // earns them. This test is what makes those negatives falsifiable: it proves
    // both strings are findable when the screen genuinely means them.
    online();
    queryHarness.__setQueryResultForTests(settled([]));
    await render(<ApiKeys />, { wrapper });
    expect(screen.getByText("No API keys")).toBeTruthy();
    expect(screen.getByText(/Nothing can reach this workspace/u)).toBeTruthy();
  });

  it("shows a revoked and a live key as different things", async () => {
    // Painting a dead key as live is how someone leaves a leak in place; painting
    // a live key as dead is how they stop looking for it.
    online();
    queryHarness.__setQueryResultForTests(
      settled([
        key(),
        key({
          id: "k-dead-1",
          label: "Leaked laptop key",
          revokedAt: new Date(Date.now() - DAY_MS).toISOString(),
        }),
      ]),
    );
    await render(<ApiKeys />, { wrapper });
    expect(screen.getByText("live")).toBeTruthy();
    expect(screen.getByText("revoked")).toBeTruthy();
  });

  it("still lists an expired key rather than hiding it", async () => {
    // An expired key is dead but its GRANTS are the record of what it could
    // reach; dropping the row would silently shrink the audit surface.
    online();
    queryHarness.__setQueryResultForTests(
      settled([
        key({
          id: "k-exp-1",
          label: "Old reporting key",
          expiresAt: new Date(Date.now() - DAY_MS).toISOString(),
        }),
      ]),
    );
    await render(<ApiKeys />, { wrapper });
    expect(screen.getByText("Old reporting key")).toBeTruthy();
    expect(screen.getByText("expired")).toBeTruthy();
  });

  // Two tests rather than one with an unmount() between them: RNTL's `screen`
  // stays bound to the unmounted tree, so every LATER test in the file would
  // query a dead render.
  it("offers Revoke on a live key", async () => {
    online();
    queryHarness.__setQueryResultForTests(settled([key()]));
    await render(<ApiKeys />, { wrapper });
    expect(screen.getByLabelText("Revoke")).toBeTruthy();
  });

  it("offers no Revoke on an already-revoked key", async () => {
    // The screen returns a plain row for a revoked key on purpose. An action
    // that can only no-op teaches the operator that revoke does nothing.
    online();
    queryHarness.__setQueryResultForTests(
      settled([
        key({
          id: "k-dead-1",
          label: "Leaked laptop key",
          revokedAt: new Date(Date.now() - DAY_MS).toISOString(),
        }),
      ]),
    );
    await render(<ApiKeys />, { wrapper });
    expect(screen.getByText("Leaked laptop key")).toBeTruthy();
    expect(screen.queryByLabelText("Revoke")).toBeNull();
  });

  it("renders a wire row missing every omitempty field", async () => {
    // Go drops lastUsedAt, revokedAt, expiresAt and actorLabel when empty, and
    // `normalizeKey` omits the keys rather than nulling them. Every one of these
    // fallbacks is a sentence: a BLANK scope line reads as "harmless", and a
    // never-used key is the most likely thing to be a forgotten leak.
    online();
    queryHarness.__setQueryResultForTests(
      settled([
        {
          id: "bare",
          label: "Untitled key",
          prefix: "",
          scopes: [],
          createdAt: "",
          actorType: "human",
          sandboxOnly: false,
        },
      ]),
    );
    await render(<ApiKeys />, { wrapper });
    expect(screen.getByText("Untitled key")).toBeTruthy();
    expect(screen.getByText("Never used")).toBeTruthy();
    expect(screen.getByText("No scopes")).toBeTruthy();
    // Not a blank line where the prefix belongs — the row must still occupy the
    // shape the reader expects.
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("tells a screen reader the key can write or send", async () => {
    // The swipe is invisible and VoiceOver users cannot perform it, so the row's
    // spoken label is the whole surface for them. A key carrying a write scope
    // announced as an ordinary key is the wrong sentence in the one place a
    // sighted user's warning colour does not reach.
    online();
    queryHarness.__setQueryResultForTests(settled([key()]));
    await render(<ApiKeys />, { wrapper });
    expect(screen.getByLabelText(/can write or send/u)).toBeTruthy();
  });

  it("does not call a read-only key dangerous", async () => {
    // The other half of the pair. Flagging every key as high-risk is how the
    // flag stops meaning anything, which is the same failure as never flagging.
    online();
    queryHarness.__setQueryResultForTests(
      settled([key({ id: "k-ro-1", scopes: ["read:campaigns"] })]),
    );
    await render(<ApiKeys />, { wrapper });
    expect(screen.getByText("CI deploy key")).toBeTruthy();
    expect(screen.queryByLabelText(/can write or send/u)).toBeNull();
  });

  it("names the agent behind a machine key", async () => {
    // A key held by an agent is a machine principal: "who do I ask before I kill
    // this" has a different answer, and an unattributed row hides that.
    online();
    queryHarness.__setQueryResultForTests(
      settled([
        key({
          id: "k-agent-1",
          label: "Digest agent",
          actorType: "agent",
          actorLabel: "weekly-digest",
        }),
      ]),
    );
    await render(<ApiKeys />, { wrapper });
    expect(screen.getByText(/agent \(weekly-digest\)/u)).toBeTruthy();
  });

  it("does not crash when the query has resolved to nothing", async () => {
    // `data === undefined` is the shape the screen actually receives before the
    // first fetch lands, and both `rows` and the subtitle guard depend on it.
    //
    // NOT ASSERTED HERE, DELIBERATELY: a TRUTHY non-array payload — `{}`, or the
    // `{items: []}` envelope `api/apiKeys.ts` itself tolerates on the wire — DOES
    // crash this screen. `sortApiKeys(keys.data ?? [])` spreads its argument, so
    // the render throws "Invalid attempt to spread non-iterable instance": the
    // MaintenanceBanner failure exactly, one line further down. It is latent
    // rather than live because `listApiKeys` always returns an array, so the only
    // route in is a restored persisted cache written by a different shape. A test
    // asserting `not.toThrow()` would fail today, and one asserting `toThrow()`
    // would pin the bug as the contract, so this is reported rather than frozen:
    // the fix is an `Array.isArray` guard in the `rows` memo.
    online();
    queryHarness.__setQueryResultForTests(settled(undefined as never));
    expect(() => render(<ApiKeys />, { wrapper })).not.toThrow();
  });

  it("survives a truthy non-array payload instead of taking the screen down", async () => {
    // REGRESSION. Before the Array.isArray guard at app/(tabs)/api-keys.tsx:72
    // this threw "Invalid attempt to spread non-iterable instance": `?? []`
    // passes a truthy `{}` or `{items: []}` straight into sortApiKeys, which
    // spreads it. Reachable from a persisted cache written by an older response
    // shape -- the same route by which MaintenanceBanner shipped its
    // "windows.find is not a function" crash in this repo.
    online();
    queryHarness.__setQueryResultForTests(settled({ items: [] } as never));
    await expect(
      render(<ApiKeys />, { wrapper }),
    ).resolves.toBeTruthy();
  });
});
