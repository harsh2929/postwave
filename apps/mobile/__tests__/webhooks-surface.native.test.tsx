/**
 * Inbound webhooks — the render contract for the endpoint row.
 *
 * WHAT THIS FILE EXISTS TO CATCH. This surface went from read-only to
 * carrying three writes, and each one has a way of being silently wrong:
 *
 *  1. THE ENABLED STATE IS NOW A CONTROL, NOT A LABEL. `enabled` used to be a
 *     Pill. If the toggle ever reverts to rendering the CURRENT state as its
 *     verb ("Enabled") instead of the ACTION ("Disable"), every operator taps
 *     the wrong way round. The label is asserted in both directions.
 *  2. THE URL MUST NOT TAIL-TRUNCATE. The slug at the end is the only part
 *     that distinguishes two endpoints; a trailing clamp hides exactly the
 *     segment being compared. The visible run must keep the tail, and the
 *     screen-reader label must carry the WHOLE url.
 *  3. REPLAY MUST BE REFUSED FOR AN UNVERIFIED EVENT, in the UI, before the
 *     round trip. The server 422s (`event_not_verified`) because replay
 *     re-executes trigger actions; a live-then-refused button teaches nothing.
 *
 * The event row is rendered directly rather than through the sheet: the
 * `@tanstack/react-query` harness returns ONE result for every `useQuery` in
 * the graph, so driving the sheet from the route would hand the events query
 * the ENDPOINT array — a mock-shape mismatch that passes while asserting
 * nothing.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import InboundWebhooks, {
  ErrorBoundary as InboundErrorBoundary,
} from "../app/(tabs)/inbound-webhooks";
import { InboundEventRow } from "../src/components/webhooks/InboundEventRow";
import { OutboundWebhookRow } from "../src/components/settings/OutboundWebhookRow";
import { ToastProvider } from "../src/components/Toast";

const queryHooks = require("./mocks/queryHooks.cjs");

// The endpoint LIST moved out of the catch-all `@/hooks/useOps` (which the
// route config mapped wholesale onto the queryHooks proxy) and into
// `@/hooks/useInboundWebhookOps`, next to the writes it invalidates
// (COMMERCE#60). Only the list is stubbed here: `useInboundWebhookActions`
// and `useInboundWebhookEvents` stay REAL so the toggle/replay controls this
// file exists to pin are still driven by the code that ships.
const mockEndpoints: { current: unknown } = { current: undefined };
jest.mock("@/hooks/useInboundWebhookOps", () => ({
  ...(jest.requireActual("@/hooks/useInboundWebhookOps") as object),
  useInboundWebhooks: () => mockEndpoints.current,
}));

/** Exactly what `useInboundWebhooks` resolves to: `InboundWebhookRow[]`. */
const ENDPOINTS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "stripe-live-payments-eu",
    name: "Stripe live",
    enabled: true,
    createdAt: "2026-07-20T09:00:00Z",
    publicUrl:
      "https://api.example.com/api/public/inbound/stripe-live-payments-eu",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "github-deploys",
    name: "GitHub deploys",
    enabled: false,
    createdAt: "2026-07-01T09:00:00Z",
    publicUrl: "https://api.example.com/api/public/inbound/github-deploys",
  },
];

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

async function renderScreen(node: React.ReactElement) {
  return render(React.createElement(ToastProvider, null, node), {
    wrapper: ({ children }) => (
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        {children}
      </SafeAreaProvider>
    ),
  });
}

afterEach(() => {
  mockEndpoints.current = undefined;
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("inbound webhooks route", () => {
  it("exports a route-scoped ErrorBoundary", async () => {
    expect(typeof InboundErrorBoundary).toBe("function");
  });

  it("offers the ACTION as the toggle label, in both directions", async () => {
    mockEndpoints.current = queryResult({ data: ENDPOINTS });
    await renderScreen(
      React.createElement(InboundWebhooks),
    );
    // Enabled endpoint → the control offers to DISABLE it, and says what that
    // costs the upstream sender.
    expect(
      screen.getByLabelText(
        "Disable Stripe live. Upstream senders will be refused until it is enabled again.",
      ),
    ).toBeTruthy();
    // Disabled endpoint → the control offers to ENABLE it.
    expect(
      screen.getByLabelText("Enable GitHub deploys so it starts accepting events again."),
    ).toBeTruthy();
  });

  it("keeps the distinguishing tail of the URL and speaks the whole thing", async () => {
    mockEndpoints.current = queryResult({ data: ENDPOINTS });
    await renderScreen(
      React.createElement(InboundWebhooks),
    );
    // The full URL is what a screen reader gets.
    expect(
      screen.getByLabelText(
        "https://api.example.com/api/public/inbound/stripe-live-payments-eu",
      ),
    ).toBeTruthy();
    // The visible run is middle-truncated: the tail survives, the middle does
    // not. A trailing clamp would fail the endsWith assertion.
    const visible = screen.getByText(/stripe-live-payments-eu$/u).props
      .children as string;
    expect(visible.endsWith("stripe-live-payments-eu")).toBe(true);
    expect(visible).toContain("…");
    // ...and the middle is what was dropped, not the tail.
    expect(visible).not.toContain("/api/public/inbound/");
  });

  it("offers copy as a first-class action, not only a share sheet", async () => {
    mockEndpoints.current = queryResult({ data: ENDPOINTS });
    await renderScreen(
      React.createElement(InboundWebhooks),
    );
    expect(screen.getByLabelText("Copy the inbound URL for Stripe live")).toBeTruthy();
    expect(
      screen.getByLabelText("Share the inbound URL for Stripe live to another app"),
    ).toBeTruthy();
  });

  it("exposes the events feed and the rotate lever per endpoint", async () => {
    mockEndpoints.current = queryResult({ data: ENDPOINTS });
    await renderScreen(
      React.createElement(InboundWebhooks),
    );
    expect(
      screen.getByLabelText("Show the events that reached Stripe live"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Rotate the signing secret for Stripe live"),
    ).toBeTruthy();
  });

  it("says the load FAILED rather than 'No inbound endpoints'", async () => {
    // The worst sentence this screen owns. An operator reconnecting a Stripe
    // integration reads "No inbound endpoints / Create endpoints from the web
    // admin" and concludes the endpoint was deleted, when a GET merely 500ed.
    mockEndpoints.current = queryResult({
      data: undefined,
      isError: true,
      isSuccess: false,
      error: new Error("HTTP 500"),
    });
    await renderScreen(React.createElement(InboundWebhooks));
    expect(screen.queryByText("No inbound endpoints")).toBeNull();
    expect(screen.getAllByLabelText("Retry").length).toBeGreaterThan(0);
  });

  it("survives a truthy non-array endpoint payload instead of going down", async () => {
    // REGRESSION. `const items = hooks.data ?? []` is a NULLISH guard, so a
    // truthy `{}` / `{items: []}` reaches `.filter` (and `.some` on the
    // secret-membership test) and throws "items.filter is not a function".
    // Reachable from a restored persisted query cache written by an older
    // response shape — the same route by which api-keys shipped "Invalid
    // attempt to spread non-iterable instance" in this repo.
    mockEndpoints.current = queryResult({ data: { items: [] } });
    await renderScreen(React.createElement(InboundWebhooks));
    // The filter is what iterates, so the crash needs a needle: typing one
    // character into the search field is the whole reproduction.
    await expect(
      fireEvent.changeText(screen.getByLabelText("Search endpoints"), "st"),
    ).resolves.not.toThrow();
    // Guarded to the empty list rather than crashing: the screen is still
    // there, still searchable, and still offering the retry-shaped empty copy.
    expect(screen.getByLabelText("Search endpoints")).toBeTruthy();
  });

  it("names the other half of the subject instead of leaving it to a guess", async () => {
    mockEndpoints.current = queryResult({ data: ENDPOINTS });
    await renderScreen(
      React.createElement(InboundWebhooks),
    );
    expect(
      screen.getByLabelText(
        "Open webhook health, the outbound half: delivery failures, replay and re-enable",
      ),
    ).toBeTruthy();
  });
});

describe("inbound event row", () => {
  const verified = {
    id: "9007199254740993",
    endpointId: ENDPOINTS[0]!.id,
    signatureValid: true,
    receivedAt: "2026-07-25T09:00:00Z",
    body: '{"type":"payment_intent.succeeded"}',
    headers: { "X-Stripe-Event": "payment_intent.succeeded" },
  };

  it("keeps a bigint event id exact — a rounded id replays the wrong event", async () => {
    // 9007199254740993 is 2^53 + 1: it cannot survive a JS number.
    expect(Number(verified.id).toString()).not.toBe(verified.id);
    await renderScreen(
      React.createElement(InboundEventRow, {
        event: verified,
        replaying: false,
        busy: false,
        onReplay: jest.fn(),
        onCopyBody: jest.fn(),
      }),
    );
    expect(
      screen.getByLabelText(`Replay event ${verified.id} through your triggers`),
    ).toBeTruthy();
  });

  it("refuses replay for an unverified event, with the reason on screen", async () => {
    await renderScreen(
      React.createElement(InboundEventRow, {
        event: { ...verified, signatureValid: false },
        replaying: false,
        busy: false,
        onReplay: jest.fn(),
        onCopyBody: jest.fn(),
      }),
    );
    const button = screen.getByLabelText(
      new RegExp(`^Replay is unavailable for event ${verified.id}`, "u"),
    );
    expect(button.props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText(/must never reach them/u)).toBeTruthy();
  });

  it("refuses replay when the payload was not retained", async () => {
    await renderScreen(
      React.createElement(InboundEventRow, {
        event: { ...verified, body: "" },
        replaying: false,
        busy: false,
        onReplay: jest.fn(),
        onCopyBody: jest.fn(),
      }),
    );
    expect(
      screen.getByLabelText(
        new RegExp(`^Replay is unavailable for event ${verified.id}`, "u"),
      ).props.accessibilityState.disabled,
    ).toBe(true);
    expect(screen.getByText("The payload for this event is no longer retained.")).toBeTruthy();
  });

  it("states the signature verdict in words, never in colour alone", async () => {
    await renderScreen(
      React.createElement(InboundEventRow, {
        event: { ...verified, signatureValid: false },
        replaying: false,
        busy: false,
        onReplay: jest.fn(),
        onCopyBody: jest.fn(),
      }),
    );
    expect(screen.getByText("signature failed")).toBeTruthy();
  });
});

/**
 * The OUTBOUND row, in Settings. It could previously only be tested and
 * DELETED — the one irreversible option — while `PATCH /{id}` and
 * `POST /{id}/rotate-secret` had been available all along. Both levers must
 * be present, and Rotate must state that it is in flight rather than looking
 * tappable twice.
 */
describe("outbound webhook row", () => {
  const webhook = {
    id: "33333333-3333-4333-8333-333333333333",
    url: "https://receiver.example.com/hooks/postwave",
    description: "Data warehouse",
    events: ["campaign.sent"],
    active: true,
    created_at: "2026-07-01T09:00:00Z",
    consecutive_failures: 0,
  };

  function renderRow(
    over: Partial<React.ComponentProps<typeof OutboundWebhookRow>> = {},
  ) {
    return renderScreen(
      <OutboundWebhookRow
        webhook={webhook}
        testing={false}
        deleting={false}
        rotating={false}
        onTest={jest.fn()}
        onDelete={jest.fn()}
        onEdit={jest.fn()}
        onRotate={jest.fn()}
        {...over}
      />,
    );
  }

  it("offers edit and rotate beside the irreversible delete", async () => {
    await renderRow();
    expect(
      screen.getByLabelText(
        "Edit the destination and event subscriptions of Data warehouse",
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Rotate the signing key for Data warehouse"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Delete the webhook Data warehouse"),
    ).toBeTruthy();
  });

  it("locks the rotate control while a rotation is in flight", async () => {
    await renderRow({ rotating: true });
    const button = screen.getByLabelText(
      "Rotate the signing key for Data warehouse",
    );
    expect(button.props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText("Rotating…")).toBeTruthy();
  });
});
