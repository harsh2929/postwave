/**
 * Per-endpoint outbound delivery history — the render contract for the
 * drill-down that answers "show me only THIS receiver's recent attempts".
 *
 * WHAT THIS FILE EXISTS TO CATCH. The Webhooks screen already had a GLOBAL
 * delivery feed, so every failure mode here is a sentence that is *nearly*
 * right — which is the expensive kind on an on-call surface:
 *
 *  1. THE PAGE IS BOUNDED BY WHAT WAS FETCHED. "1 terminal failure in the
 *     loaded trailing 24-hour window" is desktop's own wording, and the word
 *     "loaded" is load-bearing: the count is over the pages the phone has,
 *     not over the server's history. Dropping it turns a partial read into a
 *     claim about the whole endpoint.
 *  2. "NO OLDER DELIVERIES" MUST ONLY BE SAID WHEN THE SERVER SAID IT. The
 *     keyset cursor is the only thing that knows; a footer that always
 *     renders the reassuring sentence tells an operator the outage started
 *     here when the phone simply stopped paging.
 *  3. A REPEATED ROW IS A LIVE CURSOR, NOT A SECOND ATTEMPT. A keyset page
 *     boundary that moved under a live feed hands back a delivery already
 *     shown; rendering it twice both misreports the failure count and gives
 *     the FlatList two identical keys.
 *  4. REPLAY ON A PAUSED DESTINATION IS REFUSED UP FRONT, with desktop's
 *     reason, rather than discovered as a 409 after the tap.
 *  5. AND THE ROUTE MUST ACTUALLY REACH IT. A sheet nobody can open is the
 *     same as no sheet; the Deliveries control on the expanded row, and the
 *     role sentence when it is withheld, are asserted through the screen.
 *
 * The sheet is driven DIRECTLY for everything about its content: the
 * `@tanstack/react-query` harness returns ONE result for every query in the
 * graph, so opening it from the route would hand the history query the
 * ENDPOINT array — a mock-shape mismatch that passes while asserting nothing.
 * The route block below therefore asserts only what the route owns: that the
 * control exists, what it says, and that pressing it opens the sheet.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { OutboundDeliveriesSheet } from "@/components/webhooks/OutboundDeliveriesSheet";
import * as Gate from "@/hooks/useOnlineQueryGate";

import Webhooks from "../app/(tabs)/webhooks";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
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

const HOUR_MS = 60 * 60 * 1000;

/** A row shaped exactly as GET /api/v1/outbound-webhooks marshals one. */
function wireWebhook(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    url: "https://receiver.example.com/hooks/postwave",
    description: "Data warehouse",
    events: ["campaign.sent"],
    active: true,
    created_at: "2026-07-01T09:00:00Z",
    last_succeeded_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    consecutive_failures: 0,
    ...overrides,
  };
}

/** One `Delivery` as `parseOutboundDeliveryPage` hands it to the sheet. */
function delivery(overrides: Record<string, unknown> = {}) {
  return {
    id: "d-1",
    webhook_id: "11111111-1111-4111-8111-111111111111",
    event_type: "campaign.sent",
    attempt_count: 1,
    status: "delivered",
    created_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
    ...overrides,
  };
}

/**
 * What `useInfiniteQuery` resolves to. `pages` is the shape the sheet reads;
 * `hasNextPage` is the server's cursor, restated by TanStack.
 */
function history(
  pages: unknown,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data: { pages },
    error: null,
    fetchNextPage: jest.fn(async () => undefined),
    hasNextPage: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: undefined })),
    ...over,
  };
}

function renderSheet(over: Record<string, unknown> = {}) {
  return render(
    <OutboundDeliveriesSheet
      webhook={wireWebhook() as never}
      onClose={jest.fn()}
      {...over}
    />,
    { wrapper },
  );
}

describe("per-endpoint deliveries sheet", () => {
  it("is named for the endpoint the operator tapped, and counts what it holds", async () => {
    // `hasNextPage` is what the summary line's "older exist" half comes from:
    // the server's cursor, not a count of loaded rows.
    queryHarness.__setQueryResultForTests(
      history(
        [
          {
            deliveries: [delivery(), delivery({ id: "d-2" })],
            nextCursor: "eyJ0IjoxfQ==",
          },
        ],
        { hasNextPage: true },
      ),
    );
    await renderSheet();
    expect(screen.getByText("Data warehouse")).toBeTruthy();
    expect(screen.getByText("2 deliveries shown · older exist")).toBeTruthy();
  });

  it("says older deliveries exist ONLY while the server reports a cursor", async () => {
    queryHarness.__setQueryResultForTests(
      history([{ deliveries: [delivery()], nextCursor: "" }]),
    );
    await renderSheet();
    // Singular, and no "· older exist" tail.
    expect(screen.getByText("1 delivery shown")).toBeTruthy();
    expect(screen.queryByText(/older exist/u)).toBeNull();
    // ...and the footer states the end of history rather than offering a
    // button that would fetch the same page again.
    expect(
      screen.getByText("No older deliveries are recorded for this endpoint."),
    ).toBeTruthy();
    expect(screen.queryByText("Load older")).toBeNull();
  });

  it("offers Load older, and asks the server for the next page when pressed", async () => {
    const next = jest.fn(async () => undefined);
    queryHarness.__setQueryResultForTests(
      history([{ deliveries: [delivery()], nextCursor: "abc" }], {
        hasNextPage: true,
        fetchNextPage: next,
      }),
    );
    await renderSheet();
    await fireEvent.press(
      screen.getByLabelText("Load older deliveries for Data warehouse"),
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText("No older deliveries are recorded for this endpoint."),
    ).toBeNull();
  });

  it("counts terminal failures over the LOADED window, and says so", async () => {
    // Desktop's own sentence. "loaded" is the word that keeps a partial read
    // from reading as a claim about the endpoint's whole history.
    queryHarness.__setQueryResultForTests(
      history([
        {
          deliveries: [
            delivery({ id: "d-1", status: "exhausted", attempt_count: 5 }),
            delivery({ id: "d-2", status: "delivered" }),
            // Outside the 24h window: the same terminal status, and it must
            // NOT be counted.
            delivery({
              id: "d-3",
              status: "exhausted",
              created_at: new Date(Date.now() - 40 * HOUR_MS).toISOString(),
            }),
          ],
          nextCursor: "",
        },
      ]),
    );
    await renderSheet();
    expect(
      screen.getByText(
        "1 terminal failure in the loaded trailing 24-hour window.",
      ),
    ).toBeTruthy();
  });

  it("renders no rollup at all rather than a reassuring zero", async () => {
    queryHarness.__setQueryResultForTests(
      history([{ deliveries: [delivery()], nextCursor: "" }]),
    );
    await renderSheet();
    expect(screen.queryByText(/terminal failure/u)).toBeNull();
  });

  it("shows a delivery once when a live cursor repeats it across pages", async () => {
    // A keyset boundary that moved under a live feed hands back a row already
    // shown. Rendering it twice inflates the failure count and gives the
    // FlatList two identical keys.
    queryHarness.__setQueryResultForTests(
      history([
        { deliveries: [delivery({ id: "d-1" })], nextCursor: "abc" },
        {
          deliveries: [
            delivery({ id: "d-1", event_type: "duplicate.of.d1" }),
            delivery({ id: "d-2", event_type: "subscriber.created" }),
          ],
          nextCursor: "",
        },
      ]),
    );
    await renderSheet();
    expect(screen.getByText("campaign.sent")).toBeTruthy();
    expect(screen.getByText("subscriber.created")).toBeTruthy();
    // The repeat is dropped by ID — the first copy wins, so the second page's
    // version of d-1 never reaches a pixel.
    expect(screen.queryByText("duplicate.of.d1")).toBeNull();
    expect(screen.getByText("2 deliveries shown")).toBeTruthy();
  });

  it("refuses replay on a paused destination before the tap, with the reason", async () => {
    queryHarness.__setQueryResultForTests(
      history([{ deliveries: [delivery()], nextCursor: "" }]),
    );
    await renderSheet({ webhook: wireWebhook({ active: false }) as never });
    expect(
      screen.getByText("Activate this destination before replaying deliveries."),
    ).toBeTruthy();
  });

  it("says nothing about replay while the destination is active", async () => {
    // The counterweight: without it the assertion above would pass for a sheet
    // that always rendered the refusal.
    queryHarness.__setQueryResultForTests(
      history([{ deliveries: [delivery()], nextCursor: "" }]),
    );
    await renderSheet();
    expect(
      screen.queryByText("Activate this destination before replaying deliveries."),
    ).toBeNull();
  });

  it("says nothing has been ATTEMPTED, not that the endpoint is fine", async () => {
    queryHarness.__setQueryResultForTests(history([{ deliveries: [], nextCursor: "" }]));
    await renderSheet();
    expect(screen.getByText("Nothing has been attempted yet")).toBeTruthy();
    expect(screen.getByText("No deliveries recorded")).toBeTruthy();
  });

  it("does not tell a failed history fetch that nothing was attempted", async () => {
    // The damaging lie, restated for this sheet: an operator who opened it
    // because deliveries stopped must not read "Nothing has been attempted".
    queryHarness.__setQueryResultForTests(
      history(undefined, {
        data: undefined,
        error: new Error("webhook not found"),
        isError: true,
        isSuccess: false,
      }),
    );
    await renderSheet();
    expect(screen.queryByText("Nothing has been attempted yet")).toBeNull();
    expect(screen.getByText(/Something went wrong loading this/u)).toBeTruthy();
  });

  it("survives a pages payload that is not an array", async () => {
    // `?? []` is a NULLISH guard and would sail a truthy non-array straight
    // into the merge. Reachable from a persisted cache written by an older
    // build, or a harness handing every query the same payload.
    queryHarness.__setQueryResultForTests(history({ items: [] } as unknown));
    // Rendering at all is half the assertion — `mergeDeliveryPages` iterating a
    // non-array is a red screen, not a wrong sentence. The other half is that
    // it degrades to the honest empty page rather than a blank list.
    await expect(renderSheet()).resolves.toBeTruthy();
    expect(screen.getByText("Nothing has been attempted yet")).toBeTruthy();
  });

  it("says the operator is offline rather than that the receiver is idle", async () => {
    gateHarness.__setOnlineGateForTests({ enabled: false, tenantId: "t1" });
    queryHarness.__setQueryResultForTests(
      history(undefined, {
        data: undefined,
        isLoading: false,
        isPending: true,
        isSuccess: false,
      }),
    );
    await renderSheet();
    expect(
      screen.getByText(/You're offline, so this endpoint's deliveries/u),
    ).toBeTruthy();
    expect(screen.queryByText("Nothing has been attempted yet")).toBeNull();
  });
});

/**
 * What the ROUTE owns: that the drill-down is reachable at all, what the
 * control says, and that a session that may not call the admin-only route is
 * told why rather than handed a button that 403s.
 */
describe("webhooks route → deliveries drill-down", () => {
  function loadedEndpoints() {
    queryHarness.__setQueryResultForTests({
      data: [wireWebhook()],
      error: null,
      fetchNextPage: jest.fn(async () => undefined),
      hasNextPage: false,
      isError: false,
      isFetching: false,
      isFetchingNextPage: false,
      isLoading: false,
      isPending: false,
      isSuccess: true,
      refetch: jest.fn(async () => ({ data: undefined })),
    });
  }

  it("offers the drill-down on the expanded row and opens the sheet", async () => {
    loadedEndpoints();
    await render(<Webhooks />, { wrapper });
    await fireEvent.press(screen.getByLabelText(/^Data warehouse, active\./u));
    const control = screen.getByLabelText(
      "Show the recent deliveries to Data warehouse, newest first, with replay.",
    );
    expect(control.props.accessibilityState.disabled).toBe(false);
    // Nothing is open until it is pressed.
    expect(screen.queryByLabelText("Close delivery history")).toBeNull();
    await fireEvent.press(control);
    expect(screen.getByLabelText("Close delivery history")).toBeTruthy();
  });

  it("withholds the drill-down below admin and states the role, not a 403", async () => {
    // GET /outbound-webhooks/{id}/deliveries is admin in routeauth's manifest.
    // A live-then-403 control teaches an editor nothing.
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    loadedEndpoints();
    await render(<Webhooks />, { wrapper });
    await fireEvent.press(screen.getByLabelText(/^Data warehouse, active\./u));
    const control = screen.getByLabelText(
      "Delivery history is unavailable for Data warehouse: Delivery history needs an owner or admin role.",
    );
    expect(control.props.accessibilityState.disabled).toBe(true);
    // The reason is on screen, not only in the accessibility label.
    expect(
      screen.getByText("Delivery history needs an owner or admin role."),
    ).toBeTruthy();
  });
});
