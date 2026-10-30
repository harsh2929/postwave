import { describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * The three profile sections added for AUDIENCE#28, AUDIENCE#56 and MAP#49,
 * pinned at the level where their honesty rules live.
 *
 * All three share one failure mode and it is the reason these tests exist:
 * every field they read is `omitempty` on the Go side, so "the worker never
 * scored this address", "this contact is active" and "the model has no signal
 * yet" all arrive as an ABSENT key. Rendering a zero, a $0.00 or an empty card
 * for any of them is a confident statement about something that never
 * happened.
 */
// eslint-disable-next-line import/first
import { ConfirmProvider } from "@/components/ConfirmSheet";
// eslint-disable-next-line import/first
import { ToastProvider } from "@/components/Toast";
// eslint-disable-next-line import/first
import { SubscriberArchivedCard } from "@/components/subscriber/sections/SubscriberArchivedCard";
// eslint-disable-next-line import/first
import { SubscriberPredictionCard } from "@/components/subscriber/sections/SubscriberPredictionCard";

function wrap(node: React.ReactElement) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <ConfirmProvider>{node}</ConfirmProvider>
      </ToastProvider>
    </SafeAreaProvider>,
  );
}

const SCORED = {
  historic_clv_cents: 12_000,
  predicted_clv_cents: 8_000,
  total_clv_cents: 20_000,
  churn_risk: 0.72,
  confidence: 0.81,
  data_sufficiency: "sufficient",
  churn_drivers: [
    { key: "recency", label: "No opens in 6 months", value: "182 days", impact: "high" },
  ],
  calculated_at: "2026-07-01T00:00:00Z",
};

describe("SubscriberPredictionCard — absence is not zero", () => {
  it("renders NOTHING for an address the predictive worker never scored", async () => {
    const screen = await wrap(
      <SubscriberPredictionCard prediction={undefined} />,
    );
    expect(screen.queryByText("Predicted")).toBeNull();
    // The specific lie this prevents: a $0.00 lifetime value.
    expect(screen.queryByText(/\$0/)).toBeNull();
  });

  it("renders nothing for an EMPTY prediction object either", async () => {
    const screen = await wrap(<SubscriberPredictionCard prediction={{}} />);
    expect(screen.queryByText("Predicted")).toBeNull();
  });

  it("renders the money in major units, not cents", async () => {
    const screen = await wrap(<SubscriberPredictionCard prediction={SCORED} />);
    expect(screen.getByText("Predicted")).toBeTruthy();
    // 20_000 cents is $200, never $20,000.
    expect(screen.getByText("$200")).toBeTruthy();
    expect(screen.queryByText(/20,000/)).toBeNull();
  });

  it("names the churn band as a WORD, not only a colour", async () => {
    const screen = await wrap(<SubscriberPredictionCard prediction={SCORED} />);
    expect(screen.getByText("High risk")).toBeTruthy();
    expect(screen.getByText("72%")).toBeTruthy();
  });

  it("keeps the thin-evidence caveat beside the figures it qualifies", async () => {
    const screen = await wrap(
      <SubscriberPredictionCard
        prediction={{ ...SCORED, data_sufficiency: "insufficient" }}
      />,
    );
    expect(screen.getByText(/Not enough history/i)).toBeTruthy();
    // …and the headline is relabelled so the number itself reads as an estimate.
    expect(screen.getByText("Est. total")).toBeTruthy();
  });

  it("says nothing extra when the model DID have enough history", async () => {
    const screen = await wrap(<SubscriberPredictionCard prediction={SCORED} />);
    expect(screen.queryByText(/Not enough history/i)).toBeNull();
    expect(screen.queryByText(/directional/i)).toBeNull();
    expect(screen.getByText("Total value")).toBeTruthy();
  });

  it("renders an explainable driver with a spoken impact band", async () => {
    const screen = await wrap(<SubscriberPredictionCard prediction={SCORED} />);
    expect(screen.getByText("No opens in 6 months")).toBeTruthy();
    expect(screen.getByText("High impact")).toBeTruthy();
  });

  it("renders the repeat-purchase block from cadence alone, with no prediction", async () => {
    const screen = await wrap(
      <SubscriberPredictionCard
        prediction={undefined}
        orderCadenceMetrics={{ average_days_between_orders: 30 }}
      />,
    );
    expect(screen.getByText("Repeat purchase")).toBeTruthy();
    expect(screen.getByText(/Orders roughly every 30 days/)).toBeTruthy();
    // No prediction → no money and no churn band.
    expect(screen.queryByText("Total value")).toBeNull();
  });

  it("treats a zero-day cadence as an unpopulated trait, not a daily buyer", async () => {
    const screen = await wrap(
      <SubscriberPredictionCard
        prediction={undefined}
        orderCadenceMetrics={{ average_days_between_orders: 0 }}
      />,
    );
    expect(screen.queryByText("Repeat purchase")).toBeNull();
  });
});

describe("SubscriberArchivedCard", () => {
  it("renders nothing at all for an ACTIVE contact", async () => {
    const screen = await wrap(
      <SubscriberArchivedCard
        subscriberId="s1"
        archivedAt={null}
        version='"subscriber:s1:v1"'
        canMutate
      />,
    );
    expect(screen.queryByText("Archived")).toBeNull();
  });

  it("says the contact is hidden, and offers the way back", async () => {
    const screen = await wrap(
      <SubscriberArchivedCard
        subscriberId="s1"
        archivedAt="2026-07-01T00:00:00Z"
        version='"subscriber:s1:v1"'
        canMutate
      />,
    );
    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0);
    const restore = screen.getByLabelText("Restore contact");
    expect(restore.props.accessibilityState?.disabled).toBe(false);
  });

  it("refuses the restore when the row carried NO revision token", async () => {
    // The endpoint answers 428 without an exact If-Match, so a button that
    // could only ever fail must not look pressable.
    const screen = await wrap(
      <SubscriberArchivedCard
        subscriberId="s1"
        archivedAt="2026-07-01T00:00:00Z"
        version={undefined}
        canMutate
      />,
    );
    const restore = screen.getByLabelText("Restore contact");
    expect(restore.props.accessibilityState?.disabled).toBe(true);
    expect(restore.props.accessibilityHint).toMatch(/revision token/i);
  });

  it("speaks the read-only reason rather than greying out silently", async () => {
    const screen = await wrap(
      <SubscriberArchivedCard
        subscriberId="s1"
        archivedAt="2026-07-01T00:00:00Z"
        version='"subscriber:s1:v1"'
        canMutate={false}
        disabledReason="Read-only access"
      />,
    );
    const restore = screen.getByLabelText("Restore contact");
    expect(restore.props.accessibilityState?.disabled).toBe(true);
    expect(restore.props.accessibilityHint).toBe("Read-only access");
  });
});
