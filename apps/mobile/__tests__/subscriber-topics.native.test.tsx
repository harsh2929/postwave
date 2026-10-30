/**
 * SubscriberTopicsCard — the preference centre mobile claimed to have.
 *
 * lib/desktopOnlyCapabilities.ts declared `settings/topics` covered on this
 * phone while no topic endpoint was reachable anywhere in the app. That is the
 * one failure the coverage table cannot tolerate, because its whole purpose is
 * to be believed: silence reads as "not here yet", but a coverage claim reads
 * as "look harder".
 *
 * What is pinned here:
 *   - a failed read is never rendered as "this contact has no preferences" —
 *     a lookup that did not complete is not evidence about consent;
 *   - a gateway that does not serve the route renders nothing at all;
 *   - a toggle posts the SINGLE topic, with the subscriber's address;
 *   - a viewer sees the state and cannot change it.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

// Only the WRITE is stubbed; the read hook runs for real against the suite's
// react-query harness, so the query's own shape stays under test.
jest.mock("@/hooks/useSubscriberTopics", () => {
  const actual = jest.requireActual(
    "@/hooks/useSubscriberTopics",
  ) as Record<string, unknown>;
  const mutate = jest.fn();
  return {
    ...actual,
    __mutate: mutate,
    useSetSubscriberTopic: () => ({ isPending: false, mutate }),
  };
});

import { SubscriberTopicsCard } from "@/components/subscriber/sections/SubscriberTopicsCard";

const topicsHarness = jest.requireMock("@/hooks/useSubscriberTopics") as {
  __mutate: jest.Mock;
};

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

function loaded(rows: unknown[]) {
  queryHarness.__setQueryResultForTests({
    data: rows,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: rows })),
  });
}

function failed(status: number) {
  queryHarness.__setQueryResultForTests({
    data: undefined,
    error: Object.assign(new Error("nope"), { status }),
    isError: true,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: false,
    refetch: jest.fn(async () => ({ data: undefined })),
  });
}

const TOPIC = {
  id: "t-1",
  slug: "product-news",
  name: "Product news",
  description: "Releases and changelogs.",
  optedIn: true,
  defaultOptIn: true,
};

describe("the subscriber preference centre", () => {
  it("renders each topic with this contact's own state", async () => {
    loaded([TOPIC, { ...TOPIC, id: "t-2", name: "Offers", optedIn: false }]);

    await render(
      <SubscriberTopicsCard email="ops@example.com" canMutate />,
      { wrapper },
    );

    expect(screen.getByLabelText("Product news").props.value).toBe(true);
    expect(screen.getByLabelText("Offers").props.value).toBe(false);
  });

  it("says nothing at all on a workspace with no topics", async () => {
    loaded([]);

    await render(
      <SubscriberTopicsCard email="ops@example.com" canMutate />,
      { wrapper },
    );

    expect(screen.queryByText("Preferences")).toBeNull();
  });

  it("reports a failed read rather than claiming there are no preferences", async () => {
    failed(500);

    await render(
      <SubscriberTopicsCard email="ops@example.com" canMutate />,
      { wrapper },
    );

    expect(screen.getByText(/Couldn't read this contact/)).toBeTruthy();
  });

  it("stays silent on a gateway that does not serve the route", async () => {
    failed(404);

    await render(
      <SubscriberTopicsCard email="ops@example.com" canMutate />,
      { wrapper },
    );

    expect(screen.queryByText("Preferences")).toBeNull();
    expect(screen.queryByText(/Couldn't read this contact/)).toBeNull();
  });

  it("posts one topic, keyed on the address the route wants", async () => {
    loaded([TOPIC]);

    await render(
      <SubscriberTopicsCard email="ops@example.com" canMutate />,
      { wrapper },
    );
    await fireEvent(screen.getByLabelText("Product news"), "valueChange", false);

    expect(topicsHarness.__mutate).toHaveBeenCalledWith(
      { email: "ops@example.com", topicId: "t-1", optedIn: false },
      expect.anything(),
    );
  });

  it("lets a viewer read the state without being able to change it", async () => {
    loaded([TOPIC]);

    await render(
      <SubscriberTopicsCard
        email="ops@example.com"
        canMutate={false}
        disabledReason="Changing preferences needs an editor role."
      />,
      { wrapper },
    );

    expect(screen.getByLabelText("Product news").props.disabled).toBe(true);
    expect(
      screen.getByText("Changing preferences needs an editor role."),
    ).toBeTruthy();
  });
});
