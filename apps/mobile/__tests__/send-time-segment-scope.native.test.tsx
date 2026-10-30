/**
 * SendTimeSegmentScopeCard — the scoped send-time week on the send-time screen.
 *
 * The parse rules are pinned in src/lib/sendTimeSegmentHeatmap.test.ts and the
 * URL/refusal seam in src/api/sendTimeSegmentHeatmap.test.ts. What only a render
 * test can hold:
 *
 *   - pressing a segment chip actually ASKS FOR THAT SEGMENT. The chip, the
 *     state and the hook argument are three things free to drift, and if they
 *     do the card renders the wrong audience's week with no error anywhere;
 *   - the 404 is rendered as the SERVER'S SENTENCE, verbatim. It carries the
 *     threshold and this segment's own count, which nothing on the client
 *     knows, so a re-worded local message would be strictly less true;
 *   - a refusal is not an error state — no retry, no "something went wrong";
 *   - offline, the chips are WITHHELD rather than offered and broken.
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

const mockGate = { enabled: true, tenantId: "t1", effectiveRole: "admin" };
const mockSegments: { data: unknown } = { data: [] };
const mockHeatmap: {
  data: unknown;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
} = {
  data: null,
  isPending: false,
  isError: false,
  error: null,
  refetch: jest.fn(),
};
const mockAskedFor: Array<string | null> = [];

jest.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => mockGate,
}));
jest.mock("@/hooks/useSegments", () => ({
  useSegments: () => ({ ...mockSegments, isPending: false }),
}));
jest.mock("@/hooks/useSendTimeSegmentHeatmap", () => ({
  useSendTimeSegmentHeatmap: (segmentId: string | null) => {
    mockAskedFor.push(segmentId);
    return mockHeatmap;
  },
}));

// eslint-disable-next-line import/first
import { SendTimeSegmentScopeCard } from "@/components/sendtime/SendTimeSegmentScopeCard";

function week(value: number): number[][] {
  return Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => value),
  );
}

beforeEach(() => {
  mockGate.enabled = true;
  mockSegments.data = [
    { id: "seg-1", name: "Weekday readers" },
    { id: "seg-2", name: "Weekend buyers" },
  ];
  mockHeatmap.data = null;
  mockHeatmap.isPending = false;
  mockHeatmap.isError = false;
  mockHeatmap.error = null;
  mockAskedFor.length = 0;
});

describe("SendTimeSegmentScopeCard", () => {
  it("asks for nothing until a scope is picked, then asks for that segment", async () => {
    await render(<SendTimeSegmentScopeCard />);
    expect(mockAskedFor[0]).toBeNull();

    await fireEvent.press(
      screen.getByLabelText("Show the send-time week for Weekend buyers"),
    );
    expect(mockAskedFor[mockAskedFor.length - 1]).toBe("seg-2");
  });

  it("renders the server's insufficient-data sentence verbatim, not an error", async () => {
    mockHeatmap.data = {
      kind: "refused",
      refusal: {
        code: "insufficient_data",
        message: "need >= 30 subscribers with open history; have 4",
      },
    };
    await render(<SendTimeSegmentScopeCard />);
    await fireEvent.press(
      screen.getByLabelText("Show the send-time week for Weekday readers"),
    );
    expect(
      screen.getByText("need >= 30 subscribers with open history; have 4"),
    ).toBeTruthy();
    expect(screen.getByText("Weekday readers can't be modelled yet")).toBeTruthy();
    // A refusal is an ANSWER: no retry affordance, no failure copy.
    expect(screen.queryByText(/Try again/iu)).toBeNull();
  });

  it("states the strongest window and the sample it was averaged over", async () => {
    mockHeatmap.data = {
      kind: "pattern",
      pattern: {
        segmentId: "seg-1",
        subscribersWithData: 412,
        grid: week(0.01).flat(),
        best: { dayOfWeek: 2, hourUTC: 14 },
        secondary: null,
        computedAt: null,
      },
    };
    await render(<SendTimeSegmentScopeCard />);
    await fireEvent.press(
      screen.getByLabelText("Show the send-time week for Weekday readers"),
    );
    expect(screen.getByText("Tue 14:00 UTC · your device's time above")).toBeTruthy();
    expect(
      screen.getByText("Averaged over 412 subscribers with open history."),
    ).toBeTruthy();
    // One accessible element per DAY, not 168 cells.
    expect(screen.getByLabelText(/^Tuesday: strongest at/u)).toBeTruthy();
  });

  it("withholds the chips offline instead of offering a read that cannot run", async () => {
    mockGate.enabled = false;
    await render(<SendTimeSegmentScopeCard />);
    expect(
      screen.queryByLabelText("Show the send-time week for Weekday readers"),
    ).toBeNull();
    expect(
      screen.getByText(
        "You're offline, so a segment's week can't be loaded. Reconnect and pull to refresh.",
      ),
    ).toBeTruthy();
  });
});
