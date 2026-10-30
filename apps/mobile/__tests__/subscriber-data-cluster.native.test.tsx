/**
 * The profile's three new Data-cluster cards — GPP sections, linked
 * custom-object records, and segment decisions. What only a rendered test
 * can pin:
 *
 *  - each card renders its loaded rows with the server-authored sentences
 *    VERBATIM (the explanation card must never re-derive a decision);
 *  - a GPP string renders verbatim, never decoded or summarized;
 *  - the honest empty line appears for a contact with nothing recorded.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { SubscriberCustomObjectsCard } from "@/components/subscriber/sections/SubscriberCustomObjectsCard";
import { SubscriberGppCard } from "@/components/subscriber/sections/SubscriberGppCard";
import { SubscriberSegmentDecisionsCard } from "@/components/subscriber/sections/SubscriberSegmentDecisionsCard";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
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

function loaded(data: unknown) {
  queryHarness.__setQueryResultForTests({
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: undefined })),
  });
}

describe("GPP card", () => {
  it("renders the stored section string verbatim with its audit provenance", async () => {
    loaded({
      sections: [{ jurisdiction: "usca", value: "DBABBg~BVQqAAAA" }],
      audit: [
        {
          jurisdiction: "usca",
          source: "cmp_webhook",
          createdAt: "2026-08-01T00:00:00Z",
        },
      ],
    });
    await render(<SubscriberGppCard subscriberId="sub-1" />, { wrapper });
    await act(async () => {
      fireEvent.press(screen.getByA11yHint(/Global Privacy Platform/));
    });
    expect(screen.getByText("DBABBg~BVQqAAAA")).toBeTruthy();
    expect(screen.getByText(/usca set by CMP webhook/)).toBeTruthy();
  });

  it("shows the honest empty line when no CMP has reported", async () => {
    loaded({ sections: [], audit: [] });
    await render(<SubscriberGppCard subscriberId="sub-1" />, { wrapper });
    await act(async () => {
      fireEvent.press(screen.getByA11yHint(/Global Privacy Platform/));
    });
    expect(screen.getByText(/No GPP sections recorded/)).toBeTruthy();
  });
});

describe("linked-records card", () => {
  it("renders links and catalog traits as labeled rows", async () => {
    loaded({
      links: [
        {
          id: "link-1",
          typeLabel: "Product",
          recordLabel: "SKU-42",
          relationship: "purchased",
        },
      ],
      catalog: [{ label: "Favorite category", value: "cycling (7 views)" }],
    });
    await render(<SubscriberCustomObjectsCard subscriberId="sub-1" />, {
      wrapper,
    });
    await act(async () => {
      fireEvent.press(screen.getByA11yHint(/Custom-object records/));
    });
    expect(screen.getByText("Product · purchased")).toBeTruthy();
    expect(screen.getByText("SKU-42")).toBeTruthy();
    expect(screen.getByText("cycling (7 views)")).toBeTruthy();
  });
});

describe("segment-decisions card", () => {
  it("renders the server's summary sentence verbatim and expands to per-condition reasons", async () => {
    loaded({
      memberships: [
        {
          segmentId: "seg-1",
          segmentName: "High-Engagement",
          isMember: false,
          summary: "matched 3 of 5 conditions in 'High-Engagement'",
          conditions: [
            {
              matched: false,
              description: "country 'SE' does not match 'DE'",
            },
          ],
        },
      ],
      stored: [],
    });
    await render(<SubscriberSegmentDecisionsCard subscriberId="sub-1" />, {
      wrapper,
    });
    await act(async () => {
      fireEvent.press(screen.getByA11yHint(/automated segmentation/));
    });
    expect(screen.getByText("Not in High-Engagement")).toBeTruthy();
    expect(
      screen.getByText("matched 3 of 5 conditions in 'High-Engagement'"),
    ).toBeTruthy();
    // The per-condition reason appears only after drilling in.
    expect(screen.queryByText(/country 'SE' does not match/)).toBeNull();
    await act(async () => {
      fireEvent.press(
        screen.getByLabelText("High-Engagement: not a member"),
      );
    });
    expect(screen.getByText(/✗ country 'SE' does not match 'DE'/)).toBeTruthy();
  });
});
