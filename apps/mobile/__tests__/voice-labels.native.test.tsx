/**
 * VoiceLabelsSection render contract.
 *
 * The section is mounted inside the Settings screen, so it had no test of its
 * own while being the one place in the app that opted out of TanStack Query,
 * the online gate, the offline queue and the Toast doctrine at once.
 *
 * What is pinned here:
 *   - the server's `total` reaches the UI (the list used to hard-cap at 25 and
 *     throw the total away, telling a 300-label workspace nothing);
 *   - "Load more" appears only while rows remain;
 *   - 404/501 is reported as a missing capability, and a 500 is NOT.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { VoiceLabelsSection } from "@/components/settings/VoiceLabelsSection";

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

function labelPage(items: unknown[], total: number) {
  return {
    data: { data: { items, total, page: 1, size: items.length }, error: null },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: jest.fn(async () => undefined),
  };
}

function errorPage(status: number) {
  return {
    data: { data: null, error: { status, message: "upstream said no" } },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: jest.fn(async () => undefined),
  };
}

const row = {
  id: "l1",
  axis: "humor",
  value: 0.75,
  sample_text: "We ship on Fridays.",
  created_at: "2026-07-20T10:00:00Z",
};

describe("voice labels section", () => {
  it("states how many of the tenant's labels are on screen", async () => {
    queryHarness.__setQueryResultForTests(labelPage([row], 300));

    await render(<VoiceLabelsSection />, { wrapper });

    expect(screen.getByText("1 of 300")).toBeTruthy();
    expect(screen.getByText("Load more")).toBeTruthy();
    expect(screen.getByText("We ship on Fridays.")).toBeTruthy();
  });

  it("stops offering more once every row is loaded", async () => {
    queryHarness.__setQueryResultForTests(labelPage([row], 1));

    await render(<VoiceLabelsSection />, { wrapper });

    expect(screen.getByText("1 of 1")).toBeTruthy();
    expect(screen.queryByText("Load more")).toBeNull();
  });

  it("reports a 404 as a missing capability", async () => {
    queryHarness.__setQueryResultForTests(errorPage(404));

    await render(<VoiceLabelsSection />, { wrapper });

    expect(
      screen.getByText("Voice labels unavailable on this deployment."),
    ).toBeTruthy();
  });

  it("never reports a 500 as a missing capability", async () => {
    queryHarness.__setQueryResultForTests(errorPage(500));

    await render(<VoiceLabelsSection />, { wrapper });

    // A 500 is a fault, not a product boundary: claiming the deployment lacks
    // the feature would be a lie about the gateway.
    expect(
      screen.queryByText("Voice labels unavailable on this deployment."),
    ).toBeNull();
    expect(screen.getByText("Submit label")).toBeTruthy();
  });

  it("never renders a failed read as an empty corpus", async () => {
    // `listVoiceLabels` RESOLVES the envelope, so `isError` stays false on a
    // 500 and the row list is empty for the wrong reason. Saying "No labels
    // submitted yet" there tells the operator the trainer has nothing when the
    // read simply failed.
    queryHarness.__setQueryResultForTests(errorPage(500));

    await render(<VoiceLabelsSection />, { wrapper });

    expect(screen.queryByText(/No labels submitted yet/)).toBeNull();
    expect(
      screen.getByText(
        "The server had a problem with this request. Please try again.",
      ),
    ).toBeTruthy();
  });

  it("names a 403 as a permission verdict rather than an empty corpus", async () => {
    queryHarness.__setQueryResultForTests(errorPage(403));

    await render(<VoiceLabelsSection />, { wrapper });

    expect(screen.queryByText(/No labels submitted yet/)).toBeNull();
    expect(
      screen.getByText(
        "You don't have access to this. Ask a workspace administrator if you need it.",
      ),
    ).toBeTruthy();
    // A retry on a 403 is a button that can never work.
    expect(screen.queryByLabelText("Retry")).toBeNull();
  });

  it("survives a non-array items payload instead of crashing the screen", async () => {
    // A truthy non-array reaching .map is the crash that already took out
    // api-keys ("Invalid attempt to spread non-iterable instance"); `?? []`
    // does not catch it.
    queryHarness.__setQueryResultForTests({
      data: { data: { items: {}, total: 0, page: 1, size: 0 }, error: null },
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      refetch: jest.fn(async () => undefined),
    });

    await render(<VoiceLabelsSection />, { wrapper });

    expect(screen.getByText(/No labels submitted yet/)).toBeTruthy();
  });

  it("says it is offline rather than claiming the corpus is empty", async () => {
    // The gate DISABLES the query offline, so it neither loads nor errors —
    // the one state that reaches the empty branch with nothing behind it.
    gateHarness.__setOnlineGateForTests({ enabled: false });
    queryHarness.__setQueryResultForTests({
      data: undefined,
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      refetch: jest.fn(async () => undefined),
    });

    await render(<VoiceLabelsSection />, { wrapper });

    expect(screen.queryByText(/No labels submitted yet/)).toBeNull();
    expect(screen.getByText(/You're offline, so the recent labels/)).toBeTruthy();
  });

  it("still says the corpus is empty when the read genuinely succeeded", async () => {
    queryHarness.__setQueryResultForTests(labelPage([], 0));

    await render(<VoiceLabelsSection />, { wrapper });

    expect(screen.getByText(/No labels submitted yet/)).toBeTruthy();
  });
});
