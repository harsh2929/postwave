/**
 * Segment sizing — the render contract for the control that makes a stale
 * number current.
 *
 * `SegmentSummaryCard` renders "Last sized 3 days ago", or "not evaluated yet",
 * as its headline fact. That fact was read-only until now: the operator could
 * see the number was stale and had no way to act on it, while
 * `POST /api/v1/segments/{id}/recompute` recounts synchronously.
 *
 * The card is driven DIRECTLY rather than through the detail screen. The
 * react-query harness sets one result for every useQuery in the module graph,
 * so rendering the screen would hand the segment and its size-history the same
 * payload — the mock-shape mismatch that makes a suite pass while asserting
 * nothing.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { SegmentSummaryCard } from "@/components/segments/SegmentDetailCards";
import type { MobileSegment } from "@/api/segments";

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

function segment(overrides: Partial<MobileSegment> = {}): MobileSegment {
  return {
    id: "s1",
    name: "Engaged readers",
    description: "",
    queryAst: null,
    lastCount: 1240,
    lastEvaluatedAt: "2026-08-15T09:00:00Z",
    createdAt: "2026-06-01T09:00:00Z",
    ...overrides,
  } as MobileSegment;
}

describe("segment sizing control", () => {
  it("offers Refresh size for an already-evaluated segment", async () => {
    await render(
      <SegmentSummaryCard segment={segment()} onRecompute={jest.fn()} />,
      { wrapper },
    );
    expect(screen.getByText("Refresh size")).toBeTruthy();
  });

  it("says 'Size it now' when the segment has never been evaluated", async () => {
    // "Refresh" would be wrong: there is nothing to refresh, and the card
    // already tells the reader it has never been sized.
    await render(
      <SegmentSummaryCard
        segment={segment({ lastCount: null, lastEvaluatedAt: null })}
        onRecompute={jest.fn()}
      />,
      { wrapper },
    );
    expect(screen.getByText("Size it now")).toBeTruthy();
  });

  it("withholds the control below editor", async () => {
    // The route is write:subscribers. A viewer offered this control could only
    // ever meet a 403.
    await render(
      <SegmentSummaryCard segment={segment()} onRecompute={null} />,
      { wrapper },
    );
    expect(screen.queryByText("Refresh size")).toBeNull();
    expect(screen.queryByText("Size it now")).toBeNull();
  });

  it("invokes the recompute exactly once per press", async () => {
    const onRecompute = jest.fn();
    await render(
      <SegmentSummaryCard segment={segment()} onRecompute={onRecompute} />,
      { wrapper },
    );
    fireEvent.press(screen.getByText("Refresh size"));
    expect(onRecompute).toHaveBeenCalledTimes(1);
  });

  it("blocks a second press while one is in flight", async () => {
    // The handler is synchronous server-side; a double-tap would run the whole
    // count twice for no benefit.
    const onRecompute = jest.fn();
    await render(
      <SegmentSummaryCard
        segment={segment()}
        onRecompute={onRecompute}
        recomputing
      />,
      { wrapper },
    );
    fireEvent.press(screen.getByText("Sizing…"));
    expect(onRecompute).not.toHaveBeenCalled();
  });

  it("still shows the size that is there while re-sizing", async () => {
    // Blanking the number during the request would make the card briefly claim
    // the segment has no members.
    await render(
      <SegmentSummaryCard segment={segment()} onRecompute={jest.fn()} recomputing />,
      { wrapper },
    );
    expect(screen.getByText("1,240")).toBeTruthy();
  });
});
