/**
 * Segment decay radar — the render contract for the alert mobile could not see.
 *
 * The server has flagged segments quietly collapsing since
 * apps/api/internal/segments/decay.go, and web consumes every route
 * (apps/web/src/lib/segments-api.ts). Mobile called none of them: an audience
 * that lost most of its members overnight was invisible on the one device an
 * operator carries, and a dismissal could only ever be recorded on a desktop —
 * so the two surfaces disagreed about what had been handled.
 *
 * The card is driven DIRECTLY rather than through the detail screen, for the
 * reason segment-recompute.native.test.tsx already documents: the react-query
 * harness returns one result for every useQuery in the module graph, so
 * rendering the screen would hand the segment, its size history and the decay
 * read the same payload — a suite that passes while asserting nothing.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { SegmentDecayCard } from "@/components/segments/SegmentDecayCard";
import type { SegmentDecayEvent } from "@/api/segmentDecay";

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

function event(overrides: Partial<SegmentDecayEvent> = {}): SegmentDecayEvent {
  return {
    id: "ev-1",
    segmentId: "s1",
    snapshotDate: "2026-08-20",
    anomalyKind: "size_cliff",
    priorCount: 12480,
    newCount: 1204,
    leaverCount: 11300,
    entrantCount: 24,
    narration: "",
    dismissedAt: null,
    createdAt: "2026-08-20T03:00:00Z",
    ...overrides,
  };
}

const quiet = {
  isError: false,
  error: null,
  onRetry: jest.fn(),
};

describe("segment decay radar", () => {
  it("also renders nothing before the read has answered", async () => {
    await render(
      <SegmentDecayCard {...quiet} events={undefined} onDismiss={null} />,
      { wrapper },
    );
    expect(screen.queryByText("Decay radar")).toBeNull();
  });

  it("renders nothing at all when there is nothing to report", async () => {
    // A permanent "No anomalies" panel trains people to stop reading the one
    // card on this screen that is ever urgent.
    await render(
      <SegmentDecayCard {...quiet} events={[]} onDismiss={null} />,
      { wrapper },
    );
    // Not even the heading: the card is absent, not empty.
    expect(screen.queryByText("Decay radar")).toBeNull();
  });

  it("states the transition behind the alert", async () => {
    await render(
      <SegmentDecayCard {...quiet} events={[event()]} onDismiss={null} />,
      { wrapper },
    );
    expect(screen.getByText("Size cliff")).toBeTruthy();
    expect(
      screen.getByText("12,480 → 1,204 members · 11,300 left, 24 entered"),
    ).toBeTruthy();
    expect(screen.getByText("1 open alert")).toBeTruthy();
  });

  it("renders the server's narration verbatim", async () => {
    // It is model-authored server-side; re-wording it here would put words in
    // its mouth.
    const narration =
      "The clause on last_order_at now excludes most of the audience.";
    await render(
      <SegmentDecayCard
        {...quiet}
        events={[event({ narration })]}
        onDismiss={null}
      />,
      { wrapper },
    );
    expect(screen.getByText(narration)).toBeTruthy();
  });

  it("shows an alert whose kind the client has never heard of", async () => {
    await render(
      <SegmentDecayCard
        {...quiet}
        events={[event({ anomalyKind: "membership_churn" })]}
        onDismiss={null}
      />,
      { wrapper },
    );
    expect(screen.getByText("Membership churn")).toBeTruthy();
  });

  it("withholds Dismiss below editor", async () => {
    // The route is write:subscribers. A viewer offered the control could only
    // ever meet a 403.
    await render(
      <SegmentDecayCard {...quiet} events={[event()]} onDismiss={null} />,
      { wrapper },
    );
    expect(screen.queryByText("Dismiss")).toBeNull();
  });

  it("hands the whole event to the dismiss handler, once per press", async () => {
    const onDismiss = jest.fn();
    await render(
      <SegmentDecayCard {...quiet} events={[event()]} onDismiss={onDismiss} />,
      { wrapper },
    );
    fireEvent.press(
      screen.getByLabelText("Dismiss Size cliff alert from 2026-08-20"),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ id: "ev-1" }));
  });

  it("blocks a second press while the dismissal is in flight", async () => {
    // There is no un-dismiss route; firing it twice is two irreversible writes.
    const onDismiss = jest.fn();
    await render(
      <SegmentDecayCard
        {...quiet}
        events={[event()]}
        onDismiss={onDismiss}
        dismissingId="ev-1"
      />,
      { wrapper },
    );
    fireEvent.press(screen.getByText("Dismissing…"));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("says the read FAILED rather than implying the segment is healthy", async () => {
    await render(
      <SegmentDecayCard
        events={[]}
        isError
        error={new Error("decay read exploded")}
        onRetry={jest.fn()}
        onDismiss={null}
      />,
      { wrapper },
    );
    expect(screen.getByText("Decay radar")).toBeTruthy();
    expect(screen.queryByText("1 open alert")).toBeNull();
  });
});
