/**
 * Lists and Forms open their OWN create sheet when they arrive with `?new=1`.
 *
 * The palette's "New list" / "New form" (lib/paletteCreateItems) route to the
 * list screens with the flag campaigns/index.tsx already consumed; these two
 * consume it through hooks/useCreateParam. Without the consumer the verb lands
 * on the bare list and reads as having done nothing — which is exactly the
 * register's complaint about "new camp".
 *
 * Each screen gets a NEGATIVE control first: with no flag the sheet's content
 * must be absent from the tree. That is what makes the positive assertion
 * falsifiable — the sheets are modals, and if the modal mock rendered its
 * children while hidden the "opened" assertion would pass vacuously.
 *
 * `router.setParams` is not on the expo-router mock (owned elsewhere), so it
 * is attached per test and removed again.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import * as ExpoRouter from "expo-router";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";

import FormsIndex from "../app/(tabs)/forms/index";
import Lists from "../app/(tabs)/lists";
import SequencesIndex from "../app/(tabs)/sequences/index";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};
const routerHarness = ExpoRouter as unknown as {
  __setSearchParamsForTests: (over: Record<string, string> | null) => void;
  router: { setParams?: jest.Mock };
};

beforeEach(() => {
  routerHarness.router.setParams = jest.fn();
  gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
});

afterEach(() => {
  routerHarness.__setSearchParamsForTests(null);
  delete routerHarness.router.setParams;
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

const settled = {
  error: null,
  isError: false,
  isFetching: false,
  isLoading: false,
  isPending: false,
  isRefetching: false,
  isSuccess: true,
  dataUpdatedAt: 0,
  refetch: jest.fn(async () => ({ data: undefined })),
  fetchNextPage: jest.fn(async () => undefined),
  hasNextPage: false,
  isFetchingNextPage: false,
};

describe("Lists arriving with ?new=1", () => {
  /** The shape `useListOptions` resolves to: `{ rows, total }`, not a bare array. */
  const emptyLists = { ...settled, data: { rows: [], total: 0 } };

  it("keeps the create sheet closed without the flag", async () => {
    queryHarness.__setQueryResultForTests(emptyLists);

    await render(<Lists />, { wrapper });

    // Not "Create a list": the header "+" button carries that label whether or
    // not the sheet is open, so only the sheet's own inputs can discriminate.
    expect(screen.queryByLabelText("List name")).toBeNull();
    expect(routerHarness.router.setParams).not.toHaveBeenCalled();
  });

  it("opens the create sheet and clears the flag", async () => {
    queryHarness.__setQueryResultForTests(emptyLists);
    routerHarness.__setSearchParamsForTests({ new: "1" });

    await render(<Lists />, { wrapper });

    expect(await screen.findByLabelText("List name")).toBeTruthy();
    expect(screen.getByLabelText("Create this list")).toBeTruthy();
    expect(screen.getByText("New list")).toBeTruthy();
    expect(routerHarness.router.setParams).toHaveBeenCalledWith({
      new: undefined,
    });
  });
});

describe("Forms arriving with ?new=1", () => {
  /** `listForms` resolves an envelope: `{ data: { items }, error }`. */
  const emptyForms = {
    ...settled,
    data: { data: { items: [] }, error: null },
  };

  it("keeps the create sheet closed without the flag", async () => {
    queryHarness.__setQueryResultForTests(emptyForms);

    await render(<FormsIndex />, { wrapper });

    expect(screen.queryByLabelText("Form name")).toBeNull();
    expect(routerHarness.router.setParams).not.toHaveBeenCalled();
  });

  it("opens the create sheet and clears the flag", async () => {
    queryHarness.__setQueryResultForTests(emptyForms);
    routerHarness.__setSearchParamsForTests({ new: "1" });

    await render(<FormsIndex />, { wrapper });

    expect(await screen.findByLabelText("Form name")).toBeTruthy();
    expect(screen.getByLabelText("Create the form as a draft")).toBeTruthy();
    expect(routerHarness.router.setParams).toHaveBeenCalledWith({
      new: undefined,
    });
  });
});

describe("Sequences arriving with ?new=1", () => {
  /**
   * The shared "Build a sequence" CTA (routeKey sequences.new) and the
   * palette both arrive with this flag. Until now the list ignored it and
   * left the create action "one tap away" in the header — a destination that
   * did not do what its name said.
   */
  const emptySequences = {
    ...settled,
    data: { items: [], error: null, fromSnapshot: false },
  };

  it("keeps the create sheet closed without the flag", async () => {
    queryHarness.__setQueryResultForTests(emptySequences);

    await render(<SequencesIndex />, { wrapper });

    expect(screen.queryByLabelText("Sequence name")).toBeNull();
    expect(routerHarness.router.setParams).not.toHaveBeenCalled();
  });

  it("opens the create sheet and clears the flag", async () => {
    queryHarness.__setQueryResultForTests(emptySequences);
    routerHarness.__setSearchParamsForTests({ new: "1" });

    await render(<SequencesIndex />, { wrapper });

    expect(await screen.findByLabelText("Sequence name")).toBeTruthy();
    expect(routerHarness.router.setParams).toHaveBeenCalledWith({
      new: undefined,
    });
  });
});
