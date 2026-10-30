/**
 * Search — the failure the palette hid.
 *
 * The screen fans out to the server AND filters a LOCAL catalogue of screens
 * and actions. Its whole error ladder lived in `ListEmptyComponent`, and a
 * SectionList renders that only when it has no sections at all — so the moment
 * the query matched any screen name (which is most queries: "camp", "sub",
 * "list" all hit a primary tab), a 500 from the server search rendered as a
 * short, confident list of screens with no hint that the subscriber/campaign
 * half of the answer had failed.
 *
 * That is failure mode (a) wearing a disguise: not the words "No matches", but
 * the same claim made by omission, and made while the count above the list
 * reads "1 match".
 *
 * The two tests below pin both halves — the notice appears when sections exist,
 * and the pre-existing empty-list ladder still fires when they do not.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";

import SearchScreen from "../app/(tabs)/search";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = QueryHooks as unknown as {
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

/** A settled, FAILED search — the shape TanStack leaves after a 500. */
function failed() {
  return {
    data: undefined,
    error: { status: 500, message: "boom" },
    isError: true,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: false,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

/** ErrorState renders errorPresentation()'s 5xx sentence, never raw text. */
const SERVER_FAILED = "The server had a problem with this request. Please try again.";

async function typeQuery(text: string) {
  // useDebounced is identity in the route harness, so one change is enough.
  await fireEvent.changeText(screen.getByLabelText("Search Moosewave"), text);
}

describe("search screen states the server failure", () => {
  it("shows the failure even when the local palette matched", async () => {
    queryHarness.__setQueryResultForTests(failed());

    await render(<SearchScreen />, { wrapper });
    // "camp" matches the Campaigns tab, so the section list is NOT empty and
    // ListEmptyComponent never renders.
    await typeQuery("camp");

    expect(screen.getByText("Go to")).toBeTruthy();
    // ErrorState's status-aware copy for a 5xx (lib/errorCopy).
    expect(screen.getAllByText(SERVER_FAILED).length).toBeGreaterThan(0);
  });

  it("still states the failure when nothing matched at all", async () => {
    queryHarness.__setQueryResultForTests(failed());

    await render(<SearchScreen />, { wrapper });
    // A string no screen name or action contains — sections are empty.
    await typeQuery("zzqqxx@example.test");

    expect(screen.queryByText("No matches.")).toBeNull();
    expect(screen.getAllByText(SERVER_FAILED).length).toBeGreaterThan(0);
  });

  it("says nothing extra when the search succeeded", async () => {
    queryHarness.__setQueryResultForTests({
      data: { hits: [], partial: false, truncated: false },
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      isPending: false,
      isSuccess: true,
      refetch: jest.fn(async () => ({ data: undefined })),
    });

    await render(<SearchScreen />, { wrapper });
    await typeQuery("camp");

    expect(screen.getByText("Go to")).toBeTruthy();
    expect(screen.queryAllByText(SERVER_FAILED)).toHaveLength(0);
  });
});
