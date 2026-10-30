import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import RetentionOffersRoute, {
  ErrorBoundary as RetentionErrorBoundary,
} from "../app/(tabs)/retention-offers";
import { RetentionOffersScreen } from "../src/components/retention-offers/RetentionOffersScreen";
import { ToastProvider } from "../src/components/Toast";

const queryHooks = require("./mocks/queryHooks.cjs");

jest.mock("@/hooks/useRetentionOffers", () =>
  require("./mocks/queryHooks.cjs"),
);

/**
 * MAP#44 / COMMERCE#28 — the retention-offer funnel on a phone.
 *
 * The failure modes worth a test here are all failures of HONESTY, not of
 * rendering, because this screen reports on a subsystem that is only partly
 * switched on:
 *
 *   FUNNEL OUTAGE  the offers list and the funnel rollup are separate GETs. A
 *                  funnel that fails must render em-dashes; zeros are exactly
 *                  what a genuinely-unused offer looks like, and an operator
 *                  would conclude the save flow is dead.
 *   NO DENOMINATOR `acceptance_rate` is assigned server-side only inside
 *                  `if t.Shown > 0`, so an unshown offer arrives carrying a
 *                  plain 0 that renders as a damning "0%".
 *   403            every route is owner|admin via a guard at the MOUNT SITE
 *                  (main.go:2925), invisible in handlers.go. A viewer must be
 *                  told whose permission is missing, not that the workspace
 *                  has no offers.
 *   WIN-BACK       `enabled` is stored configuration, never proof that the
 *                  uncomposed worker can enroll or dispatch.
 */

const TIER_ID = "11111111-2222-4333-8444-555555555555";

function offer(over: Record<string, unknown> = {}) {
  return {
    id: "off-1",
    tierId: TIER_ID,
    percentOff: 20,
    fixedOffCents: null,
    durationMonths: 3,
    headline: "Stay for a bit less",
    couponId: "cpn_live_1",
    active: true,
    createdAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

function tile(over: Record<string, unknown> = {}) {
  return {
    offerId: "off-1",
    tierId: TIER_ID,
    shown: 40,
    accepted: 10,
    declined: 26,
    expired: 4,
    ...over,
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

/** Loaded offers + loaded funnel — the ordinary case every test starts from. */
function withLoadedFunnel(
  over: { offers?: unknown[]; tiles?: unknown[] } = {},
) {
  queryHooks.__setHookResultForTests(
    "useRetentionOffers",
    queryResult({ data: over.offers ?? [offer()] }),
  );
  queryHooks.__setHookResultForTests(
    "useRetentionFunnel",
    queryResult({ data: over.tiles ?? [tile()] }),
  );
}

function renderScreen(Component: React.ComponentType = RetentionOffersScreen) {
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
});

describe("retention-offers route file", () => {
  it("mounts the default export the router actually loads", async () => {
    withLoadedFunnel();
    const result = await renderScreen(RetentionOffersRoute);
    expect(result.getByText("Retention offers")).toBeTruthy();
  });

  it("exports a route-scoped ErrorBoundary", () => {
    expect(typeof RetentionErrorBoundary).toBe("function");
  });

  it("states the exact stored evidence and release boundary", async () => {
    // The server mounts three GETs and nothing else; an operator hunting for
    // an edit button deserves to be told why there isn't one.
    withLoadedFunnel();
    const result = await renderScreen();
    expect(result.getByText("Stored retention evidence only")).toBeTruthy();
    expect(
      result.getByText(/stored offer rows, stored win-back settings/),
    ).toBeTruthy();
    expect(result.getByText(/aggregate event counters/)).toBeTruthy();
    expect(
      result.getByText(/does not identify customers or prove/),
    ).toBeTruthy();
    expect(
      result.getByText(/ASSURE-F15-WINBACK-DISPATCH-UNWIRED/),
    ).toBeTruthy();
  });
});

describe("retention funnel honesty", () => {
  it("renders real counts and an acceptance rate when the funnel loaded", async () => {
    withLoadedFunnel();
    const result = await renderScreen();

    expect(result.getByLabelText("40 Shown")).toBeTruthy();
    expect(result.getByLabelText("10 Accepted")).toBeTruthy();
    expect(result.getByLabelText("26 Declined")).toBeTruthy();
    expect(result.getByLabelText("4 Expired")).toBeTruthy();
    expect(result.getByText("Acceptance rate 25.0% of 40 shown")).toBeTruthy();
  });

  it("shows em-dashes — never zeros — when the funnel read failed", async () => {
    // A zero here is indistinguishable from an offer nobody has been shown.
    queryHooks.__setHookResultForTests(
      "useRetentionOffers",
      queryResult({ data: [offer()] }),
    );
    queryHooks.__setHookResultForTests(
      "useRetentionFunnel",
      queryResult({ isError: true, error: { status: 500 } }),
    );
    const result = await renderScreen();

    expect(result.getByLabelText("Shown unknown — not loaded")).toBeTruthy();
    expect(result.getByLabelText("Accepted unknown — not loaded")).toBeTruthy();
    expect(result.queryByLabelText("0 Shown")).toBeNull();
    expect(result.queryByLabelText("0 Accepted")).toBeNull();
    expect(
      result.getByText(/didn't load, so these counts are unknown — not zero/),
    ).toBeTruthy();
    // The offers themselves came from a different read and are still listed.
    expect(result.getByText("20% off · 3 months")).toBeTruthy();
  });

  it("offers a retry that is scoped to the funnel alone", async () => {
    queryHooks.__setHookResultForTests(
      "useRetentionOffers",
      queryResult({ data: [offer()] }),
    );
    queryHooks.__setHookResultForTests(
      "useRetentionFunnel",
      queryResult({ isError: true, error: { status: 500 } }),
    );
    const result = await renderScreen();
    expect(
      result.getByLabelText("Retry loading the offer funnel"),
    ).toBeTruthy();
  });

  it("does not present retained funnel data as current after a failed refetch", async () => {
    queryHooks.__setHookResultForTests(
      "useRetentionOffers",
      queryResult({ data: [offer()] }),
    );
    queryHooks.__setHookResultForTests(
      "useRetentionFunnel",
      queryResult({
        data: [tile()],
        isError: true,
        error: { status: 500 },
      }),
    );
    const result = await renderScreen();

    expect(result.getByLabelText("Shown unknown — not loaded")).toBeTruthy();
    expect(result.queryByLabelText("40 Shown")).toBeNull();
  });

  it("shows no acceptance rate at all when nothing has ever been shown", async () => {
    // `acceptance_rate` is only assigned when Shown > 0, so the wire's 0 means
    // "no denominator" — rendering it as 0% would libel the offer.
    withLoadedFunnel({
      tiles: [tile({ shown: 0, accepted: 0, declined: 0, expired: 0 })],
    });
    const result = await renderScreen();

    expect(
      result.getByText("Acceptance rate — · nothing shown yet"),
    ).toBeTruthy();
    expect(result.queryByText(/Acceptance rate 0\.0%/)).toBeNull();
    // And the observation list explains it in a sentence.
    expect(
      result.getByText(
        "No recorded shown event exists for the stored active offers.",
      ),
    ).toBeTruthy();
  });

  it("keeps conflicting counters visible but withholds their rate", async () => {
    withLoadedFunnel({
      tiles: [tile({ shown: 40, accepted: 10, declined: 31, expired: 0 })],
    });
    const result = await renderScreen();

    expect(result.getByLabelText("40 Shown")).toBeTruthy();
    expect(result.getByLabelText("31 Declined")).toBeTruthy();
    expect(result.getAllByText("Outcome-count conflict").length).toBeGreaterThan(0);
    expect(
      result.getByText("Acceptance rate — · outcome-count conflict"),
    ).toBeTruthy();
    expect(result.queryByText(/Acceptance rate 25\.0%/u)).toBeNull();
  });
});

describe("retention offer rows", () => {
  it("names the tier when the tier read resolved one", async () => {
    withLoadedFunnel();
    queryHooks.__setHookResultForTests(
      "usePaywallTierNames",
      queryResult({ data: { [TIER_ID]: "Founding member" } }),
    );
    const result = await renderScreen();
    expect(result.getByText("Founding member")).toBeTruthy();
  });

  it("falls back to a truncated id, and says so, when tier names failed", async () => {
    withLoadedFunnel();
    queryHooks.__setHookResultForTests(
      "usePaywallTierNames",
      queryResult({ isError: true, error: { status: 500 } }),
    );
    const result = await renderScreen();
    // A missing NAME is cosmetic — it must not become an error state.
    expect(result.getByText("Tier 111111…555555")).toBeTruthy();
    expect(
      result.getByText(
        "Tier names didn't load, so rows show the tier id instead.",
      ),
    ).toBeTruthy();
    expect(result.getByLabelText("40 Shown")).toBeTruthy();
  });

  it("does not use a retained tier name after the tier read fails", async () => {
    withLoadedFunnel();
    queryHooks.__setHookResultForTests(
      "usePaywallTierNames",
      queryResult({
        data: { [TIER_ID]: "Stale name" },
        isError: true,
        error: { status: 500 },
      }),
    );
    const result = await renderScreen();

    expect(result.getByText("Tier 111111…555555")).toBeTruthy();
    expect(result.queryByText("Stale name")).toBeNull();
  });

  it("prints fixed minor units without inventing currency or precision", async () => {
    // Migration 0306 stores fixed_off_cents with no currency column and the
    // wire carries none. The server's own FormatAmount hard-codes "$".
    withLoadedFunnel({
      offers: [offer({ percentOff: null, fixedOffCents: 500 })],
    });
    const result = await renderScreen();
    expect(result.getByText("500 minor units off · 3 months")).toBeTruthy();
    expect(result.queryByText("$5.00 off · 3 months")).toBeNull();
  });

  it("flags an active offer whose Stripe coupon was never mirrored", async () => {
    // AcceptOffer returns ErrProviderReferenceRequired on a blank coupon id,
    // so this offer could not apply a discount even if someone accepted it.
    withLoadedFunnel({ offers: [offer({ couponId: "" })] });
    const result = await renderScreen();
    expect(result.getByText("No Stripe coupon on record")).toBeTruthy();
    expect(
      result.getByText(
        "1 offer marked active has no Stripe coupon on record; coupon application is unavailable and cannot be inferred.",
      ),
    ).toBeTruthy();
  });

  it("says a stored inactive flag in WORDS, not only in colour", async () => {
    withLoadedFunnel({ offers: [offer({ active: false })] });
    const result = await renderScreen();
    expect(result.getByText("Marked inactive")).toBeTruthy();
    expect(
      result.getByText(
        "No stored offer row is marked active. This release does not mount offer presentation or delivery.",
      ),
    ).toBeTruthy();
  });
});

describe("win-back status", () => {
  it("keeps an enabled stored switch separate from runtime availability", async () => {
    withLoadedFunnel();
    queryHooks.__setHookResultForTests(
      "useWinbackSettings",
      queryResult({
        data: { enabled: true, churnThreshold: 0.7, churnProfilesScored: 0 },
      }),
    );
    const result = await renderScreen();

    expect(result.getByText("Stored enabled")).toBeTruthy();
    expect(
      result.getByText(
        "The stored win-back switch is enabled, but no churn-scored profiles are recorded. Runtime dispatch remains release-held and unavailable.",
      ),
    ).toBeTruthy();
  });

  it("reports stored threshold and population without claiming enrollment", async () => {
    withLoadedFunnel();
    queryHooks.__setHookResultForTests(
      "useWinbackSettings",
      queryResult({
        data: {
          enabled: true,
          churnThreshold: 0.55,
          churnProfilesScored: 1240,
        },
      }),
    );
    const result = await renderScreen();
    expect(result.getByText("Stored enabled")).toBeTruthy();
    expect(
      result.getByText(
        "The stored switch is enabled at a 55.0% threshold; 1,240 profiles are recorded as scored. Automated delivery is rollout-held (ASSURE-F15-WINBACK-DISPATCH-UNWIRED), so no enrollment or dispatch can be inferred.",
      ),
    ).toBeTruthy();
  });

  it("says UNKNOWN, not 'off', when the settings read did not land", async () => {
    // Rendering "Off" from an absent read tells an operator their win-backs
    // are switched off when the app has no idea.
    withLoadedFunnel();
    const result = await renderScreen();
    expect(
      result.getByText(
        "Stored win-back configuration unknown — the settings didn't load.",
      ),
    ).toBeTruthy();
    expect(result.queryByText("Off")).toBeNull();
  });

  it("does not present retained settings as current after a failed refetch", async () => {
    withLoadedFunnel();
    queryHooks.__setHookResultForTests(
      "useWinbackSettings",
      queryResult({
        data: {
          enabled: true,
          churnThreshold: 0.55,
          churnProfilesScored: 1240,
        },
        isError: true,
        error: { status: 500 },
      }),
    );
    const result = await renderScreen();

    expect(
      result.getByText(
        "Stored win-back configuration unknown — the settings didn't load.",
      ),
    ).toBeTruthy();
    expect(result.queryByText("Stored enabled")).toBeNull();
  });
});

describe("authorization and failure states", () => {
  it("explains a 403 instead of claiming the workspace has no offers", async () => {
    queryHooks.__setHookResultForTests(
      "useRetentionOffers",
      queryResult({ isError: true, error: { status: 403 } }),
    );
    const result = await renderScreen();

    expect(result.getByText("Needs an owner or admin session")).toBeTruthy();
    expect(result.queryByText("No retention offers yet")).toBeNull();
  });

  it("keeps a NON-scope failure an error, never an empty state", async () => {
    queryHooks.__setHookResultForTests(
      "useRetentionOffers",
      queryResult({ isError: true, error: { status: 500 } }),
    );
    const result = await renderScreen();
    expect(result.queryByText("Needs an owner or admin session")).toBeNull();
    expect(result.queryByText("No retention offers yet")).toBeNull();
  });

  it("distinguishes offline from 'no offers configured'", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false, isOnline: false });
    queryHooks.__setHookResultForTests("useRetentionOffers", queryResult({}));
    const result = await renderScreen();
    expect(result.queryByText("No retention offers yet")).toBeNull();
    expect(
      result.getByText(/The offer funnel needs a connection/),
    ).toBeTruthy();
  });

  it("renders a real empty state when the workspace genuinely has none", async () => {
    queryHooks.__setHookResultForTests(
      "useRetentionOffers",
      queryResult({ data: [] }),
    );
    queryHooks.__setHookResultForTests(
      "useRetentionFunnel",
      queryResult({ data: [] }),
    );
    const result = await renderScreen();
    expect(result.getByText("No retention offers yet")).toBeTruthy();
  });
});
