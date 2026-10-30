/**
 * Outbound webhook health — the render contract for the on-call surface.
 *
 * WHY THIS FILE EXISTS. `app/(tabs)/webhooks.tsx` had never been mounted by
 * anything. `webhooks-surface.native.test.tsx` covers the INBOUND route, the
 * inbound event row and the Settings `OutboundWebhookRow` — none of which is
 * this screen — and `routes.native.test.tsx` does not import it. `EndpointRow`
 * and `DeliveryRow` had likewise never been rendered.
 *
 * That is not a bookkeeping gap. `MaintenanceBanner` shipped the same way in
 * this programme and its render test — not its 31 policy tests — caught it
 * taking down the whole dashboard with "windows.find is not a function" the
 * first time a query answered with something other than an array. A screen
 * nobody has rendered is a screen whose first open is the test, and this
 * particular screen gets opened at 3am by someone who is already worried.
 *
 * WHAT IS DRIVEN WHERE, and why it matters. The `@tanstack/react-query` harness
 * sets ONE result for EVERY `useQuery` in the module graph, and this screen has
 * three: the endpoint list, the delivery feed, and the per-endpoint 24h health
 * rollup. The route is safe to render as a whole ONLY because the other two are
 * gated behind state the screen starts without — `deliveries` behind
 * `segment === "deliveries"`, `health` behind an expanded row — so on mount the
 * endpoint payload is the only one that reaches a pixel. The moment an
 * assertion needs a delivery row or a health rollup, the component is driven
 * directly instead; feeding the endpoint list a delivery array is exactly the
 * mock-shape mismatch that makes a suite pass while asserting nothing.
 *
 * WHAT THIS PROTECTS. Every assertion is about a WRONG SENTENCE or a crash:
 *
 *   - "No outbound webhooks" rendered because the request FAILED tells an
 *     operator their delivery subscriptions are gone. On the screen whose job
 *     is to say whether events are reaching their systems, that is the most
 *     damaging string available, and it is one collapsed error ladder away.
 *   - The Endpoints badge is the number the operator reads first. Counting a
 *     healthy endpoint would send them hunting for a failure that isn't there;
 *     missing an auto-disabled one hides the outage.
 *   - "Resume" on an auto-disabled endpoint is the WRONG VERB: resume just
 *     re-flips `active` and the delivery worker disables it again. Re-enable is
 *     the one that makes the server re-validate the destination.
 *   - A success RATE over zero deliveries is not 100%, it is undefined. "100%
 *     success" on an endpoint that has delivered nothing is a lie in the
 *     reassuring direction.
 *   - Offering replay on an in-flight delivery is a control that can only 409.
 *
 * THE ASSERTION THAT USED TO BE ABSENT is now the last one in the route block.
 * The MaintenanceBanner failure reproduced here verbatim: with `data` set to a
 * non-array object the screen died on `endpointRows.filter is not a function`
 * (webhooks.tsx, the `failingCount` memo, which runs before the list does).
 * That shape is reachable — `useOutboundWebhooks` returned
 * `res.data?.webhooks ?? []`, and `??` does not guard a `webhooks` field that
 * arrived as an object rather than an array, nor a cache persisted by an older
 * build. Both ends now guard with Array.isArray, and the case is pinned below
 * alongside `data: undefined`.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { DeliveryRow } from "@/components/webhooks/DeliveryRow";
import { EndpointRow } from "@/components/webhooks/EndpointRow";
import * as Gate from "@/hooks/useOnlineQueryGate";

import Webhooks from "../app/(tabs)/webhooks";

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

/** A row shaped exactly as `normalizeDelivery` hands one to the screen. */
function wireDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: "d-1",
    webhook_id: "11111111-1111-4111-8111-111111111111",
    event_type: "campaign.sent",
    attempt_count: 5,
    status: "exhausted",
    last_status_code: 503,
    last_error: "upstream connect error or disconnect/reset before headers",
    created_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
    ...overrides,
  };
}

/** The 24h rollup as `fetchWebhookHealth` normalizes it. */
function wireHealth(overrides: Record<string, unknown> = {}) {
  return {
    deliveries_total: 40,
    deliveries_succeeded: 38,
    deliveries_failed: 2,
    deliveries_pending: 0,
    deliveries_skipped: 0,
    consecutive_failures: 0,
    auto_disabled: false,
    ...overrides,
  };
}

function loaded(value: unknown) {
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

/** What a gated-off query looks like: never fetched, never resolved. */
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
  hookHarness.__setOnlineGateForTests({ enabled: true, tenantId: "t1" });
}

function offline() {
  hookHarness.__setOnlineGateForTests({ enabled: false, tenantId: "t1" });
}

describe("outbound webhook health route", () => {
  it("mounts at all", async () => {
    // The assertion this whole file is really for: before it, nothing had ever
    // rendered this screen, this row, or this delivery feed.
    online();
    queryHarness.__setQueryResultForTests(loaded([wireWebhook()]));
    await render(<Webhooks />, { wrapper });
    expect(screen.getByText("Webhooks")).toBeTruthy();
    expect(screen.getByText("Data warehouse")).toBeTruthy();
  });

  it("renders the freshness line that was on the wire and never shown", async () => {
    // `last_succeeded_at` shipped typed on the client and rendered nowhere, so
    // "has this delivered anything today?" was answerable from data already in
    // memory and the screen answered with silence.
    online();
    queryHarness.__setQueryResultForTests(loaded([wireWebhook()]));
    await render(<Webhooks />, { wrapper });
    expect(screen.getByText(/^Last delivered/u)).toBeTruthy();
  });

  it("names the receive half instead of leaving it to a guess", async () => {
    // Desktop merges send and receive into one shell; a phone cannot, so
    // "events aren't flowing" must not become a guess about which route to
    // open.
    online();
    queryHarness.__setQueryResultForTests(loaded([wireWebhook()]));
    await render(<Webhooks />, { wrapper });
    expect(
      screen.getByLabelText(
        "Open inbound webhooks, the receive half: endpoint URLs, arriving events and replay",
      ),
    ).toBeTruthy();
  });

  it("badges Endpoints with the count of endpoints that need attention", async () => {
    // The first number the operator reads. An inactive endpoint and one with a
    // failure streak both count; a healthy one must not, or they go hunting for
    // an outage that isn't there.
    online();
    queryHarness.__setQueryResultForTests(
      loaded([
        wireWebhook({ id: "healthy" }),
        wireWebhook({ id: "paused", description: "Paused sink", active: false }),
        wireWebhook({
          id: "streak",
          description: "Failing sink",
          consecutive_failures: 4,
          last_failed_at: new Date(Date.now() - HOUR_MS).toISOString(),
        }),
      ]),
    );
    await render(<Webhooks />, { wrapper });
    expect(screen.getByText("2")).toBeTruthy();
    // ...and the streak itself is stated, not just counted into the badge.
    expect(screen.getByText(/4 consecutive failures/u)).toBeTruthy();
  });

  it("distinguishes a failure from a delivery in the freshness line", async () => {
    // `last_failed_at` newer than `last_succeeded_at` is the case that matters:
    // "Last delivered 3 days ago" on an endpoint that failed a minute ago reads
    // as stale-but-fine.
    online();
    queryHarness.__setQueryResultForTests(
      loaded([
        wireWebhook({
          last_succeeded_at: new Date(Date.now() - 48 * HOUR_MS).toISOString(),
          last_failed_at: new Date(Date.now() - HOUR_MS).toISOString(),
        }),
      ]),
    );
    await render(<Webhooks />, { wrapper });
    expect(screen.getByText(/^Last failure/u)).toBeTruthy();
    expect(screen.queryByText(/^Last delivered/u)).toBeNull();
  });

  it("does not tell a failed fetch that no webhooks exist", async () => {
    // The damaging lie. "No outbound webhooks · Create endpoints in Settings"
    // shown because the request errored tells an operator their delivery
    // subscriptions are gone, on the one screen they opened to find out whether
    // events are reaching their systems.
    online();
    queryHarness.__setQueryResultForTests(failed());
    await render(<Webhooks />, { wrapper });
    expect(screen.queryByText("No outbound webhooks")).toBeNull();
    expect(screen.queryByText(/Create endpoints in Settings/u)).toBeNull();
    // What it says instead: a load failure, with the one affordance that can
    // actually change the answer.
    expect(screen.getByText(/Something went wrong loading this/u)).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("renders the empty copy only when the fetch genuinely returned nothing", async () => {
    // Without this, the assertion above passes for the wrong reason — a screen
    // that never renders the string at all would satisfy it too.
    online();
    queryHarness.__setQueryResultForTests(loaded([]));
    await render(<Webhooks />, { wrapper });
    expect(screen.getByText("No outbound webhooks")).toBeTruthy();
  });

  it("says the operator is offline rather than that they have no webhooks", async () => {
    // Nothing is broken and nothing is missing — the phone just can't reach the
    // server. Rendering the empty state here would be a claim about their
    // workspace made from a lack of signal.
    offline();
    queryHarness.__setQueryResultForTests(gatedOff());
    await render(<Webhooks />, { wrapper });
    expect(screen.getByText(/You're offline, so webhook health/u)).toBeTruthy();
    expect(screen.queryByText("No outbound webhooks")).toBeNull();
  });

  it("survives a wire row missing every omitempty field", async () => {
    // Go's `omitempty` drops description, last_succeeded_at and last_failed_at.
    // A partial row must render — with the URL standing in for the missing
    // name, and a stated "no deliveries yet" rather than a blank line that
    // reads as fine.
    online();
    queryHarness.__setQueryResultForTests(
      loaded([
        {
          id: "bare",
          url: "https://bare.example.com/hook",
          events: [],
          active: true,
          created_at: "",
          consecutive_failures: 0,
        },
      ]),
    );
    await render(<Webhooks />, { wrapper });
    expect(screen.getByText("No deliveries yet")).toBeTruthy();
    // The row's own announcement is where the title fallback is unambiguous:
    // with no description the URL is the name, so a screen reader gets the
    // destination rather than an empty leading comma.
    expect(
      screen.getByLabelText(/^https:\/\/bare\.example\.com\/hook, active\./u),
    ).toBeTruthy();
  });

  it("does not crash when the endpoints query has resolved to no data", async () => {
    // The pre-resolution and post-error shape. `endpointRows.filter` runs
    // before the list does, which is precisely where MaintenanceBanner died.
    online();
    queryHarness.__setQueryResultForTests(loaded(undefined));
    expect(() => render(<Webhooks />, { wrapper })).not.toThrow();
  });

  it("survives an endpoints payload that is not an array", async () => {
    // `?? []` is a NULLISH guard: `{items: []}` is truthy, so it sailed
    // straight into `endpointRows.filter` in the badge memo — which runs
    // before the list renders, taking the whole on-call screen down. Reachable
    // from an envelope drift or a cache persisted by an older build. Both the
    // hook and the screen now guard with Array.isArray.
    online();
    queryHarness.__setQueryResultForTests(
      loaded({ items: [wireWebhook()] } as unknown),
    );
    expect(() => render(<Webhooks />, { wrapper })).not.toThrow();
  });

  it("survives a deliveries payload that is not an array", async () => {
    // Same guard on the other segment: the delivery feed's rows go straight
    // into a FlatList, and a non-array there is the same class of drift.
    online();
    queryHarness.__setQueryResultForTests(
      loaded({ deliveries: [wireDelivery()] } as unknown),
    );
    await render(<Webhooks />, { wrapper });
    await expect(
      fireEvent.press(screen.getByLabelText("Deliveries")),
    ).resolves.not.toThrow();
  });

  it("does not tell a failed delivery fetch that nothing is failing", async () => {
    // Same lie, worse: "Nothing failing right now" is the sentence that sends
    // an on-call operator back to sleep. Both queries share the harness's one
    // result here, and both failing is a coherent state — a server that can't
    // list endpoints can't list deliveries either.
    online();
    queryHarness.__setQueryResultForTests(failed());
    await render(<Webhooks />, { wrapper });
    // Awaited: an un-awaited press schedules the state update without flushing
    // it, so the screen stays on Endpoints and every assertion below passes
    // against the wrong segment.
    await fireEvent.press(screen.getByLabelText("Deliveries"));
    expect(
      screen.getByLabelText("Delivery status filter"),
    ).toBeTruthy();
    expect(screen.queryByText("Nothing failing right now")).toBeNull();
    expect(
      screen.queryByText(/No webhook deliveries are currently retrying/u),
    ).toBeNull();
    expect(screen.getByText(/Something went wrong loading this/u)).toBeTruthy();
  });

  it("renders the reassuring delivery copy only on a genuine empty feed", async () => {
    // The counterweight to the assertion above.
    online();
    queryHarness.__setQueryResultForTests(loaded([]));
    await render(<Webhooks />, { wrapper });
    await fireEvent.press(screen.getByLabelText("Deliveries"));
    expect(screen.getByText("Nothing failing right now")).toBeTruthy();
  });
});

/**
 * The endpoint row is driven DIRECTLY from here on. Its state label and its
 * verb both depend on the HEALTH query, and the harness would hand that query
 * the endpoint array — so every assertion about auto-disabled-versus-paused
 * would be an assertion about the mock.
 */
describe("endpoint row", () => {
  function renderRow(over: Record<string, unknown> = {}) {
    return render(
      <EndpointRow
        webhook={wireWebhook() as never}
        expanded
        onToggle={jest.fn()}
        health={undefined}
        healthLoading={false}
        busy={false}
        onPauseResume={jest.fn()}
        onReEnable={jest.fn()}
        {...over}
      />,
      { wrapper },
    );
  }

  it("calls an auto-disabled endpoint auto-disabled, and offers Re-enable", async () => {
    // The whole reason the health rollup is fetched. "Resume" here is the wrong
    // verb: it re-flips `active` and the delivery worker disables the endpoint
    // again. Only re-enable makes the server re-validate the destination.
    await renderRow({
      webhook: wireWebhook({ active: false }) as never,
      health: wireHealth({
        auto_disabled: true,
        disabled_reason: "receiver returned 401 on 12 consecutive attempts",
        deliveries_failed: 12,
      }) as never,
    });
    expect(screen.getByText("auto-disabled")).toBeTruthy();
    expect(
      screen.getByText("receiver returned 401 on 12 consecutive attempts"),
    ).toBeTruthy();
    expect(screen.getByText("Re-enable")).toBeTruthy();
    expect(screen.queryByText("Resume")).toBeNull();
  });

  it("does not guess auto-disabled before health has answered", async () => {
    // An inactive endpoint with no rollup yet is described neutrally. Claiming
    // "auto-disabled" from an absent answer invents an outage.
    await renderRow({ webhook: wireWebhook({ active: false }) as never });
    expect(screen.getByText("paused")).toBeTruthy();
    expect(screen.getByText("Resume")).toBeTruthy();
    expect(screen.queryByText("auto-disabled")).toBeNull();
  });

  it("says the health rollup couldn't be loaded rather than showing zeroes", async () => {
    // A rollup that failed and a rollup of nothing look identical if the
    // absence renders as "0 deliveries · 0 failed".
    await renderRow({ health: undefined });
    expect(screen.getByText(/Delivery health couldn't be loaded/u)).toBeTruthy();
    expect(screen.queryByText(/0 deliveries/u)).toBeNull();
  });

  it("calls a success rate over zero deliveries undefined, not 100%", async () => {
    // 38/40 renders as a percentage; 0/0 must not. "100% success" on an
    // endpoint that has delivered nothing in 24h is a lie in the reassuring
    // direction, which is the expensive one here.
    await renderRow({ health: wireHealth({ deliveries_total: 40 }) as never });
    expect(screen.getByText(/95% success/u)).toBeTruthy();
  });

  it("renders a dash for the rate when nothing was delivered at all", async () => {
    await renderRow({
      health: wireHealth({
        deliveries_total: 0,
        deliveries_succeeded: 0,
        deliveries_failed: 0,
      }) as never,
    });
    expect(screen.getByText(/— success/u)).toBeTruthy();
    expect(screen.queryByText(/100% success/u)).toBeNull();
  });

  it("locks the action while a write is in flight", async () => {
    // Two pauses is one PATCH the operator did not ask for.
    await renderRow({ busy: true });
    expect(
      screen.getByLabelText(/^Pause Data warehouse/u).props.accessibilityState
        .disabled,
    ).toBe(true);
  });
});

/**
 * The delivery row, likewise driven directly: the feed is the screen's SECOND
 * query, and rendering it through the route would feed the endpoint list a
 * delivery array.
 */
describe("delivery row", () => {
  it("leads with the receiver's own failure reason, not a generic verdict", async () => {
    // The status code plus the receiver's message is the whole diagnosis. A
    // bare "failed" pill sends the operator to a laptop.
    await render(
      <DeliveryRow delivery={wireDelivery() as never} onReplay={jest.fn()} />,
      { wrapper },
    );
    expect(screen.getByText("campaign.sent")).toBeTruthy();
    expect(screen.getByText("exhausted")).toBeTruthy();
    expect(screen.getByText(/HTTP 503/u)).toBeTruthy();
    expect(
      screen.getByText(
        "upstream connect error or disconnect/reset before headers",
      ),
    ).toBeTruthy();
  });

  it("publishes replay as an accessibility action, not gesture-only", async () => {
    // The swipe has no affordance and VoiceOver cannot perform it, so the
    // rotor action is the only non-gesture path to the one write this feed
    // offers.
    await render(
      <DeliveryRow delivery={wireDelivery() as never} onReplay={jest.fn()} />,
      { wrapper },
    );
    const row = screen.getByLabelText(/^campaign\.sent, exhausted, HTTP 503/u);
    expect(row.props.accessibilityActions).toEqual([
      { name: "Replay", label: "Replay" },
    ]);
  });

  it("offers no replay on a delivery that is still in flight", async () => {
    // The server 409s on a pending delivery, so a live-then-refused control
    // teaches the operator nothing except not to trust the screen.
    await render(
      <DeliveryRow
        delivery={
          wireDelivery({
            status: "pending",
            attempt_count: 1,
            last_status_code: undefined,
            last_error: undefined,
            next_attempt_at: new Date(Date.now() + HOUR_MS).toISOString(),
          }) as never
        }
        onReplay={jest.fn()}
      />,
      { wrapper },
    );
    const row = screen.getByLabelText(/Still in flight\.$/u);
    // The mirror of the assertion above, and the one that bites: the swipe
    // panel only mounts once dragged, so "no Replay label on screen" would be
    // true for a replayable row too. The rotor action list is the difference.
    expect(row.props.accessibilityActions).toBeUndefined();
    // ...and it says when the retry is coming, so "pending" is not a dead end.
    expect(screen.getByText(/^Next retry/u)).toBeTruthy();
  });

  it("survives a delivery row missing every omitempty field", async () => {
    // `next_attempt_at`, `last_status_code`, `last_error` and `delivered_at`
    // are all dropped by the server for a clean delivery.
    await render(
      <DeliveryRow
        delivery={
          {
            id: "bare",
            webhook_id: "w",
            event_type: "subscriber.created",
            attempt_count: 1,
            status: "delivered",
            created_at: new Date(Date.now() - HOUR_MS).toISOString(),
          } as never
        }
        onReplay={jest.fn()}
      />,
      { wrapper },
    );
    expect(screen.getByText("subscriber.created")).toBeTruthy();
    expect(screen.getByText(/1 attempt$/u)).toBeTruthy();
  });
});
