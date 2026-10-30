import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import ConversionsRoute, {
  ErrorBoundary as ConversionsErrorBoundary,
} from "../app/(tabs)/conversions";
import { ConversionsScreen } from "../src/components/conversions/ConversionsScreen";
import { ToastProvider } from "../src/components/Toast";
import {
  normalizeAttributionTimeseries,
  normalizeCampaignAttribution,
  ROLLUP_CAMPAIGN_NAME,
} from "../src/lib/conversionAttribution";

const queryHooks = require("./mocks/queryHooks.cjs");
const authStore = require("./mocks/authStore.cjs");

jest.mock("@/hooks/useConversionAttribution", () =>
  require("./mocks/queryHooks.cjs"),
);

/**
 * The conversion monitor has five states a "does it render" test never reaches,
 * and each one is a place where the app could state something false:
 *
 *   SILENCE vs ZERO — "no conversions reported" and "conversions that carried
 *                     no amount" are different facts. Collapsing them tells an
 *                     operator whose signup events fire perfectly that their
 *                     tracking is dead.
 *   HEURISTIC       — last_touch is a 7-day click join, and the payload's own
 *                     type comment says clients must never present it as
 *                     certain. The provenance card is not decoration.
 *   CURRENCY        — every *_cents figure is the dominant currency only, so a
 *                     mixed-currency window is under-reported unless the
 *                     exclusion is named.
 *   NO DENOMINATOR  — revenue_per_send_cents is OMITTED (nil) when the campaign
 *                     has no recorded sends. A 0 there is a lie.
 *   ROLL-UP         — the item list is capped at 50 with a folded
 *                     "(other campaigns)" row, and total_campaigns is captured
 *                     before the fold.
 */

function attributionWire(over: Record<string, unknown> = {}) {
  return {
    items: [
      {
        campaign_id: "c1",
        campaign_name: "Spring sale",
        conversions: 40,
        revenue_cents: 250_000,
        emails_sent: 10_000,
        revenue_per_send_cents: 25,
      },
      {
        campaign_id: "c2",
        campaign_name: "Welcome flow",
        conversions: 5,
        revenue_cents: 5_000,
        emails_sent: 0,
      },
    ],
    provenance: { explicit: 30, last_touch: 15, none: 4, unclassified: 1 },
    total_revenue_cents: 300_000,
    unattributed_cents: 45_000,
    unattributed_conversions: 4,
    currency: "USD",
    currencies: [
      { currency: "USD", conversions: 45, revenue_cents: 300_000 },
      { currency: "EUR", conversions: 3, revenue_cents: 12_000 },
    ],
    total_campaigns: 2,
    days: 30,
    ...over,
  };
}

function timeseriesWire() {
  return {
    points: [
      { date: "2026-07-24", revenue_cents: 0, conversions: 0 },
      { date: "2026-07-25", revenue_cents: 300_000, conversions: 45 },
    ],
    currency: "USD",
    currencies: [{ currency: "USD", conversions: 45, revenue_cents: 300_000 }],
    days: 30,
  };
}

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

function load(attribution: Record<string, unknown>) {
  queryHooks.__setHookResultForTests(
    "useCampaignAttribution",
    queryResult({ data: normalizeCampaignAttribution(attribution) }),
  );
  queryHooks.__setHookResultForTests(
    "useAttributionTimeseries",
    queryResult({ data: normalizeAttributionTimeseries(timeseriesWire()) }),
  );
}

async function renderScreen(Component: React.ComponentType = ConversionsScreen) {
  return render(
    React.createElement(ToastProvider, null, React.createElement(Component)),
    {
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
    },
  );
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  authStore.__resetAuthStateForTests();
});

describe("conversions route file", () => {
  it("mounts the default export the router actually loads", async () => {
    load(attributionWire());
    const result = await renderScreen(ConversionsRoute);
    expect(result.getByText("Conversions")).toBeTruthy();
  });

  it("exports a route-scoped ErrorBoundary", () => {
    expect(typeof ConversionsErrorBoundary).toBe("function");
  });
});

describe("authorization", () => {
  it("renders for a viewer — both guards admit every role on these routes", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "viewer" } });
    load(attributionWire());
    const result = await renderScreen();
    expect(result.getByText("Revenue by campaign")).toBeTruthy();
    expect(result.queryByText("This session cannot read reports")).toBeNull();
  });

  it("calls a live 403 a missing session permission, not an admin wall", async () => {
    queryHooks.__setHookResultForTests(
      "useCampaignAttribution",
      queryResult({ isError: true, error: { status: 403 } }),
    );
    queryHooks.__setHookResultForTests(
      "useAttributionTimeseries",
      queryResult({ data: undefined }),
    );
    const result = await renderScreen();
    expect(result.getByText("This session cannot read reports")).toBeTruthy();
    expect(result.getByText(/not an admin wall/)).toBeTruthy();
  });
});

describe("silence is not zero", () => {
  it("calls a window with nothing reported silence from the tracking script", async () => {
    load(
      attributionWire({
        items: [],
        provenance: { explicit: 0, last_touch: 0, none: 0, unclassified: 0 },
        currencies: [],
        currency: "",
        total_revenue_cents: 0,
        unattributed_cents: 0,
        total_campaigns: 0,
      }),
    );
    const silent = await renderScreen();
    expect(silent.getByText("No conversions in the last 30 days")).toBeTruthy();
    expect(silent.queryByText(/none carrying an amount/)).toBeNull();
  });

  it("calls a window of non-monetary conversions something else entirely", async () => {
    load(
      attributionWire({
        items: [],
        provenance: { explicit: 3, last_touch: 0, none: 0, unclassified: 0 },
        currencies: [],
        currency: "",
        total_revenue_cents: 0,
        unattributed_cents: 0,
        total_campaigns: 0,
      }),
    );
    const nonMonetary = await renderScreen();
    expect(
      nonMonetary.getByText("3 conversions, none carrying an amount"),
    ).toBeTruthy();
    expect(
      nonMonetary.queryByText("No conversions in the last 30 days"),
    ).toBeNull();
  });

  it("shows em-dashes rather than a $0.00 that was never measured", async () => {
    load(
      attributionWire({
        items: [],
        provenance: { explicit: 3, last_touch: 0, none: 0, unclassified: 0 },
        currencies: [],
        currency: "",
        total_revenue_cents: 0,
        unattributed_cents: 0,
      }),
    );
    const result = await renderScreen();
    expect(result.getAllByText("—").length).toBeGreaterThan(0);
    expect(result.queryByText("$0.00")).toBeNull();
  });
});

describe("honesty disclosures", () => {
  it("names last touch as a 7-day click heuristic", async () => {
    load(attributionWire());
    const result = await renderScreen();
    expect(result.getByText(/matched to a campaign by last touch/)).toBeTruthy();
    expect(result.getByText(/heuristic, not a tag/)).toBeTruthy();
  });

  it("keeps unclassified rows separate from unattributed ones", async () => {
    load(attributionWire());
    expect(
      (await renderScreen()).getByText(/neither attributed nor known to be unattributed/),
    ).toBeTruthy();
  });

  it("names the currency excluded from every figure on the screen", async () => {
    load(attributionWire());
    expect((await renderScreen()).getByText(/120\.00 EUR/)).toBeTruthy();
  });

  it("says nothing about currency when the window is single-currency", async () => {
    load(
      attributionWire({
        currencies: [{ currency: "USD", conversions: 45, revenue_cents: 300_000 }],
      }),
    );
    expect((await renderScreen()).queryByText(/excluded from every figure/)).toBeNull();
  });

  it("says nothing about a roll-up when the list is the whole picture", async () => {
    load(attributionWire());
    expect((await renderScreen()).queryByText(/Showing the top/)).toBeNull();
  });

  it("says 'top N of M' when the server folded a tail", async () => {
    load(
      attributionWire({
        items: [
          { campaign_id: "c1", campaign_name: "A", conversions: 1, revenue_cents: 1 },
          {
            campaign_id: "",
            campaign_name: ROLLUP_CAMPAIGN_NAME,
            conversions: 9,
            revenue_cents: 900,
          },
        ],
        total_campaigns: 80,
      }),
    );
    const folded = await renderScreen();
    expect(folded.getByText(/Showing the top 1 of 80 campaigns/)).toBeTruthy();
    expect(folded.getByText("rolled-up total")).toBeTruthy();
  });
});

describe("campaign rows", () => {
  it("renders an em-dash per send when the server omitted the denominator", async () => {
    load(attributionWire());
    const result = await renderScreen();
    expect(result.getByText("Welcome flow")).toBeTruthy();
    // The visible run is hidden from the a11y tree (the row speaks the figures
    // once, in full), so the assertion is on the spoken label — which is also
    // the surface a VoiceOver user actually receives.
    expect(
      result.getByLabelText(/no recorded sends, so there is no denominator/),
    ).toBeTruthy();
    expect(
      result.getByText("— per send", { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(
      result.queryByText("$0.00 per send", { includeHiddenElements: true }),
    ).toBeNull();
  });

  it("does not divide revenue by conversions anywhere on the screen", async () => {
    // $2,500.00 over 40 conversions would be $62.50 — the average order value
    // the two different denominators cannot support.
    load(attributionWire());
    expect((await renderScreen()).queryByText(/\$62\.50/)).toBeNull();
  });
});

describe("window control", () => {
  it("re-reads on a window change without ever emitting NaN days", async () => {
    load(attributionWire());
    const result = await renderScreen();
    expect(result.getByText("50 conversions · last 30 days")).toBeTruthy();
    await fireEvent.press(result.getByLabelText("Last 7 days"));
    // The header subtitle is derived from the window the QUERY was given, so
    // this only moves if the string key round-tripped to a real day count.
    expect(result.getByText("50 conversions · last 7 days")).toBeTruthy();
  });
});

describe("offline", () => {
  it("says the reading is unavailable rather than that nothing converted", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });
    queryHooks.__setHookResultForTests(
      "useCampaignAttribution",
      queryResult({ data: undefined }),
    );
    queryHooks.__setHookResultForTests(
      "useAttributionTimeseries",
      queryResult({ data: undefined }),
    );
    const result = await renderScreen();
    expect(
      result.getByText(/Attributed revenue needs a connection/),
    ).toBeTruthy();
  });
});

describe("monitor scoping", () => {
  it("says out loud that the PII feed and site keys stay on the web admin", async () => {
    load(attributionWire());
    expect(
      (await renderScreen()).getByText(/identifies recipients by email/),
    ).toBeTruthy();
  });
});
