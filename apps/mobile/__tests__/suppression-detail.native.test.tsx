/**
 * Suppression detail — the render contract for "why didn't this person get my
 * email?".
 *
 * WHY THIS FILE EXISTS. `app/(tabs)/suppressions/[email].tsx` had never been
 * mounted by anything. Three suites name the path — `route-tree`,
 * `nav.consistency`, `detailStack.consistency` — and not one of them renders
 * it. In this programme that gap has already cost a crashed dashboard:
 * `MaintenanceBanner` shipped with 31 green policy tests and then took the
 * whole screen down with "windows.find is not a function" the first time a
 * query answered something other than an array. A screen nobody has rendered
 * is a screen whose first open is the test.
 *
 * ONE PAYLOAD, TWO READS. The `@tanstack/react-query` harness sets a single
 * result for every `useQuery` in the module graph, and this screen composes
 * two of them: the exact-match arm of the list read (`useSuppressions`, which
 * resolves the CURRENT row) and the per-address trail (`useSuppressionAudit`).
 * There is no smaller component to drive here — the route body is the unit —
 * so `wire()` carries both wire shapes on one object. That stays honest only
 * because the two reads consume DISJOINT keys of it: the list read takes
 * `data.value.items`, the audit read takes `data.items`. Setting them
 * independently is what keeps "row present / row gone" and "history present /
 * history empty" four states instead of two, so these assertions cannot pass
 * by sharing a payload that happens to satisfy everything.
 *
 * WHAT THIS PROTECTS. Every assertion is about a WRONG SENTENCE on a
 * compliance record, never about a blank screen:
 *
 *   - "No recorded history" rendered because a request FAILED tells an
 *     operator that nothing was ever done to this address. On the one screen
 *     that exists to explain why mail stopped, that is the most damaging
 *     string available, and it is one collapsed error ladder away.
 *   - "Not currently suppressed" is a claim about a person's mailbox. It must
 *     survive the server returning a differently-cased address, and it must
 *     never be produced by a NEIGHBOURING address in the same filtered page.
 *   - A cached row presented as live lets an operator tell a customer "you're
 *     still suppressed" from a day-old snapshot.
 *   - Un-suppress is an irreversible send-reputation decision. Offering it to
 *     a session that can only be refused is a control that exists to 403.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";

import SuppressionDetail from "../app/(tabs)/suppressions/[email]";

const authStore = require("./mocks/authStore.cjs");
const expoRouter = require("./mocks/expoRouter.cjs");

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

const hookHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

const EMAIL = "bounce@example.test";
const THREE_HOURS_AGO = new Date(Date.now() - 3 * 60 * 60 * 1000);

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  hookHarness.__resetOnlineGateForTests();
  authStore.__resetAuthStateForTests();
  // `clearMocks`/`restoreMocks` reset jest.fn()s, not module state: leaving
  // this screen's `email` param behind would render the NEXT screen's test
  // against this address.
  expoRouter.__setSearchParamsForTests({});
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

/**
 * A list row as `suppressions.Entry` marshals it (store.go:120). Note what is
 * NOT there: that struct has no `status` field at all, and serialises `reason`
 * as a bare string that a converged row can leave empty — so "row present,
 * reason absent" is a real wire state, not a hypothetical.
 */
function listRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sup-1",
    email: EMAIL,
    reason: "hard_bounce",
    created_at: THREE_HOURS_AGO.toISOString(),
    ...overrides,
  };
}

/** An audit entry as `parseSuppressionAudit` hands it to the screen. */
function auditEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "aud-1",
    action: "add",
    reason: "hard_bounce",
    actor: "ses-webhook",
    createdAt: THREE_HOURS_AGO.toISOString(),
    ...overrides,
  };
}

/**
 * The two wire shapes on one object — see the header note. `rows` drives the
 * list read (`data.value.items`), `entries` drives the audit read
 * (`data.items`), and `fromSnapshot`/`capturedAt` drive the provenance notice.
 */
function wire({
  rows = [listRow()] as unknown[],
  entries = [auditEntry()] as unknown[],
  fromSnapshot = false,
  capturedAt = null as number | null,
} = {}) {
  return settled({
    value: { items: rows, total: rows.length, page: 1, size: 50 },
    fromSnapshot,
    capturedAt,
    email: EMAIL,
    total: entries.length,
    items: entries,
  });
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

function open(role = "admin", { online = true } = {}) {
  expoRouter.__setSearchParamsForTests({ email: EMAIL });
  hookHarness.__setOnlineGateForTests({
    enabled: online,
    tenantId: "t1",
    userId: "u1",
    effectiveRole: role,
    online,
    canReadOfflineSnapshots: true,
  });
}

describe("suppression detail render contract", () => {
  it("mounts at all", async () => {
    // The assertion the whole file is really for: before this, nothing had
    // ever rendered this route.
    open();
    queryHarness.__setQueryResultForTests(wire());
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.getByText("Hard bounce")).toBeTruthy();
    expect(screen.getAllByText(EMAIL).length).toBeGreaterThan(0);
  });

  it("names the reason, the actor and the event in the trail", async () => {
    // The row was a dead end before this screen existed; the whole point is
    // that it attributes the suppression to something.
    open();
    queryHarness.__setQueryResultForTests(wire());
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.getByText("Hard bounce · ses-webhook")).toBeTruthy();
    // Two nodes read "Suppressed" here and they come from DIFFERENT reads: the
    // header's verdict about the current row, and the trail entry's own verb.
    // Asserting both is what distinguishes "the trail rendered" from "the
    // header rendered and the trail collapsed".
    expect(screen.getAllByText("Suppressed")).toHaveLength(2);
  });

  it("still calls a bare row suppressed", async () => {
    // `status` is absent from the list wire entirely and `reason` can arrive
    // empty. Falling through to "Not currently suppressed" here would tell an
    // operator this address is fine while their mail is being dropped.
    open();
    queryHarness.__setQueryResultForTests(
      wire({ rows: [{ id: "sup-bare", email: EMAIL }] }),
    );
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.queryByText("Not currently suppressed")).toBeNull();
    expect(screen.getByText("unknown")).toBeTruthy();
  });

  it("resolves the row when the server's casing differs from the link's", async () => {
    // Deep links and search hits carry the address lowercased; the stored row
    // keeps whatever the bounce reported. A case-sensitive compare would
    // declare a suppressed address clear.
    open();
    queryHarness.__setQueryResultForTests(
      wire({ rows: [listRow({ email: "Bounce@Example.TEST" })] }),
    );
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.queryByText("Not currently suppressed")).toBeNull();
    expect(screen.getByText("Hard bounce")).toBeTruthy();
  });

  it("never attributes a NEIGHBOUR's reason to this address", async () => {
    // The list read is filtered server-side, and its prefix arm legitimately
    // returns other addresses. Taking items[0] would print someone else's
    // hard bounce on this person's record — a wrong sentence about a specific
    // human, which is the worst thing this screen can do.
    open();
    queryHarness.__setQueryResultForTests(
      wire({
        rows: [listRow({ id: "sup-2", email: "bounce-two@example.test" })],
      }),
    );
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.getByText("Not currently suppressed")).toBeTruthy();
    expect(screen.getByText("Not suppressed")).toBeTruthy();
    expect(screen.queryByText("Hard bounce")).toBeNull();
  });

  it("keeps explaining the address after the row is gone", async () => {
    // The trail is keyed by EMAIL server-side, so it outlives the row. That is
    // deliberate: this is the screen an operator is looking at immediately
    // after un-suppressing, and it must still say what happened and by whom.
    open();
    queryHarness.__setQueryResultForTests(
      wire({ rows: [], entries: [auditEntry({ action: "remove" })] }),
    );
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.getByText("Not currently suppressed")).toBeTruthy();
    expect(screen.getByText("Un-suppressed")).toBeTruthy();
    expect(screen.queryByLabelText(`Un-suppress ${EMAIL}`)).toBeNull();
  });

  it("renders a trail entry with no reason and no timestamp", async () => {
    // `created_at` and `reason` are both omitempty on the audit wire
    // (audit.go:47,50), and `actor` falls back to "system" for an automated
    // bounce that has neither a user nor an api key behind it.
    open();
    queryHarness.__setQueryResultForTests(
      wire({
        rows: [],
        entries: [auditEntry({ reason: "", actor: "system", createdAt: "" })],
      }),
    );
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.getByText("Suppressed")).toBeTruthy();
    expect(screen.getByText("system")).toBeTruthy();
  });

  it("does not tell a failed fetch that nothing ever happened", async () => {
    // "No recorded history" shown because the request errored is a claim about
    // the WORKSPACE made from a fact about the NETWORK. QueryStates puts error
    // before empty precisely so this cannot happen; nothing had ever checked
    // that this screen wired it that way.
    open();
    queryHarness.__setQueryResultForTests(failed());
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.queryByText("No recorded history")).toBeNull();
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("never calls an address clear because the row read FAILED", async () => {
    // The worst sentence on this screen, and it is not the history one. "Not
    // currently suppressed" — under a success-toned "Not suppressed" pill — is
    // a claim about a specific person's mailbox, and `Boolean(row)` produced it
    // from an undefined `data` whether the read succeeded with no match or
    // 500ed. An operator reads it and tells a customer their mail is flowing
    // while every send is still being dropped.
    open();
    queryHarness.__setQueryResultForTests(failed());
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.queryByText("Not currently suppressed")).toBeNull();
    expect(screen.queryByText("Not suppressed")).toBeNull();
    expect(screen.getAllByText("Status unavailable").length).toBeGreaterThan(0);
  });

  it("does not claim an address is clear before the read has answered", async () => {
    // Same lie, one state earlier: on first paint `data` is undefined for the
    // ordinary reason, and the screen still asserted a verdict.
    open();
    queryHarness.__setQueryResultForTests({
      data: undefined,
      error: null,
      isError: false,
      isFetching: true,
      isLoading: true,
      isPending: true,
      isSuccess: false,
      refetch: jest.fn(async () => ({ data: undefined })),
    });
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.queryByText("Not currently suppressed")).toBeNull();
    expect(screen.queryByText("Not suppressed")).toBeNull();
  });

  it("survives a list payload whose items are not an array", async () => {
    // `data.value.items.find(...)` is three unguarded hops over a payload that
    // reaches this screen from the SecureStore vault as well as the wire, and
    // `loadSnapshotBacked` re-reads that blob with no shape check at all
    // (deliverabilitySnapshots: `isStored` only proves `capturedAt` is a
    // number). A stored value from an older projection is a truthy non-array.
    open();
    queryHarness.__setQueryResultForTests(
      settled({ value: {}, fromSnapshot: false, capturedAt: null, items: [] }),
    );
    expect(() => render(<SuppressionDetail />, { wrapper })).not.toThrow();
  });

  it("says 'offline' rather than 'no history' with nothing cached", async () => {
    // Distinct from an error: nothing is broken, the phone just cannot reach
    // the server — and the cached row must keep rendering above the notice.
    open("admin", { online: false });
    queryHarness.__setQueryResultForTests(wire({ entries: [] }));
    await render(<SuppressionDetail />, { wrapper });
    expect(
      screen.getByText(/this address's history can't be loaded/u),
    ).toBeTruthy();
    expect(screen.queryByText("No recorded history")).toBeNull();
    expect(screen.getByText("Hard bounce")).toBeTruthy();
  });

  it("says a genuinely empty trail predates the audit, not that nothing happened", async () => {
    // The one case where the empty copy is the honest answer — older
    // suppressions really do predate the trail. Paired with the two tests
    // above so "empty" is proved to be reachable ONLY from a successful read.
    open();
    queryHarness.__setQueryResultForTests(wire({ entries: [] }));
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.getByText("No recorded history")).toBeTruthy();
  });

  it("admits when the row came from the vault rather than the wire", async () => {
    // A snapshot read is a SUCCESSFUL query with no error and no spinner, so
    // without this notice a day-old "still suppressed" reads as live and an
    // operator repeats it to a customer as fact.
    open();
    queryHarness.__setQueryResultForTests(
      wire({ fromSnapshot: true, capturedAt: THREE_HOURS_AGO.getTime() }),
    );
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.getByText(/^Cached .* reconnect to refresh\.$/u)).toBeTruthy();
  });

  it("offers un-suppress to an admin", async () => {
    // The positive control for the two gate tests below: without it, a screen
    // that never rendered the action at all would pass them both.
    open("admin");
    queryHarness.__setQueryResultForTests(wire());
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.getByLabelText(`Un-suppress ${EMAIL}`)).toBeTruthy();
  });

  it("shows a viewer the record but not the un-suppress control", async () => {
    // DELETE /deliverability/suppressions/{email} is admin-only, so the button
    // could only ever 403. Reading why mail was dropped is still worth having.
    open("viewer");
    queryHarness.__setQueryResultForTests(wire());
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.getByText("Hard bounce")).toBeTruthy();
    expect(screen.getByText("Hard bounce · ses-webhook")).toBeTruthy();
    expect(screen.queryByLabelText(`Un-suppress ${EMAIL}`)).toBeNull();
    // Share is not a write, so it survives the gate — the screen stays useful.
    expect(screen.getByLabelText(`Share ${EMAIL}`)).toBeTruthy();
  });

  it("withholds un-suppress from an api-key session even at admin role", async () => {
    // A second, independent gate: mobile api-key sessions are viewer-capped
    // regardless of the role on the key (canAccessMinimumRole), so the role
    // check alone would have offered a control that cannot work.
    open("admin");
    authStore.__setAuthStateForTests({ mode: "api_key" });
    queryHarness.__setQueryResultForTests(wire());
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.getByText("Hard bounce")).toBeTruthy();
    expect(screen.queryByLabelText(`Un-suppress ${EMAIL}`)).toBeNull();
  });

  it("renders without an email param instead of throwing", async () => {
    // Reachable from a malformed deep link. The header falls back to
    // "Suppression"; what matters is that it does not assert anything about an
    // address it was never given.
    hookHarness.__setOnlineGateForTests({
      enabled: true,
      tenantId: "t1",
      userId: "u1",
      effectiveRole: "admin",
      online: true,
      canReadOfflineSnapshots: true,
    });
    expoRouter.__setSearchParamsForTests({ email: "" });
    queryHarness.__setQueryResultForTests(wire({ rows: [], entries: [] }));
    await render(<SuppressionDetail />, { wrapper });
    expect(screen.getByText("Suppression")).toBeTruthy();
    expect(screen.getByText("Not suppressed")).toBeTruthy();
  });
});
