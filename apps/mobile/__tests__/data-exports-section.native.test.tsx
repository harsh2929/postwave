/**
 * DataExportsSection — the two things the section knew and would not say.
 *
 * 1. THE OLDER ROWS WERE NEVER ELSEWHERE. GET /api/v1/exports returns the
 *    whole list (LIMIT 200) in one response, and the section sliced five of
 *    them and captioned the rest "+N older on the web admin". The rows were
 *    already in memory; the caption sent a user to a desktop for data their
 *    phone was holding.
 *
 * 2. A QUEUED EXPORT NEVER TURNED READY ON SCREEN. The only refresh was a
 *    single refetch fired immediately after the POST, which by construction
 *    still reads `queued` — the bundle is built by a background worker. The
 *    point read GET /api/v1/exports/{id} existed for exactly this and had no
 *    caller, so the row claimed to be building until a pull-to-refresh.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { DataExportsSection } from "@/components/settings/DataExportsSection";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
  __getQueryOptionsForTests: () => {
    kind: string;
    options: {
      queryKey: unknown[];
      enabled?: boolean;
      refetchInterval?: (query: { state: { data: unknown } }) => unknown;
    };
  }[];
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

function row(id: string, status: string, include: string) {
  return {
    id,
    status,
    include: [include],
    requested_by_email: "ops@example.com",
    bytes_total: status === "ready" ? 2048 : 0,
    rows_total: status === "ready" ? 10 : 0,
    download_url: status === "ready" ? "https://example.com/bundle.zip" : "",
    expires_at: status === "ready" ? "2099-01-01T00:00:00Z" : "",
    error: "",
    created_at: "2026-08-20T10:00:00Z",
  };
}

/** Newest first, exactly as the server orders them. */
const SEVEN = [
  row("e7", "ready", "seven"),
  row("e6", "ready", "six"),
  row("e5", "ready", "five"),
  row("e4", "ready", "four"),
  row("e3", "ready", "three"),
  row("e2", "queued", "two"),
  row("e1", "running", "one"),
];

function loadedWith(rows: unknown[]) {
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

function watchQuery() {
  return queryHarness
    .__getQueryOptionsForTests()
    .find((entry) => entry.options.queryKey[0] === "tenant-export")?.options;
}

describe("data exports", () => {
  it("expands the rows it already has instead of naming the web admin", async () => {
    loadedWith(SEVEN);

    await render(<DataExportsSection />, { wrapper });

    expect(screen.queryByText(/on the web admin/)).toBeNull();
    expect(screen.getByText("three")).toBeTruthy();
    // Rows six and seven are in the same array; they are just not rendered yet.
    expect(screen.queryByText("two")).toBeNull();

    await fireEvent.press(screen.getByLabelText("Show 2 older exports"));

    expect(screen.getByText("two")).toBeTruthy();
    expect(screen.getByText("one")).toBeTruthy();
    expect(
      screen.getByLabelText("Show only the 5 most recent exports"),
    ).toBeTruthy();
  });

  it("offers no expansion when every row is already on screen", async () => {
    loadedWith([SEVEN[0], SEVEN[1]]);

    await render(<DataExportsSection />, { wrapper });

    expect(screen.queryByLabelText(/older exports/)).toBeNull();
  });

  it("watches the oldest still-building export by its own id", async () => {
    loadedWith(SEVEN);

    await render(<DataExportsSection />, { wrapper });

    const watch = watchQuery();
    expect(watch).toBeDefined();
    // e1 (`running`), not e2 — the list is newest-first, so the oldest pending
    // row is the one closest to finishing.
    expect(watch?.queryKey).toContain("e1");
    expect(watch?.enabled).toBe(true);
  });

  it("does not poll when nothing is being built", async () => {
    loadedWith([SEVEN[0], SEVEN[1]]);

    await render(<DataExportsSection />, { wrapper });

    expect(watchQuery()?.enabled).toBe(false);
  });

  it("stops polling the moment the bundle settles", async () => {
    loadedWith(SEVEN);

    await render(<DataExportsSection />, { wrapper });
    const interval = watchQuery()?.refetchInterval;
    expect(typeof interval).toBe("function");

    // Still building: keep the timer alive.
    expect(
      interval?.({ state: { data: row("e1", "running", "one") } }),
    ).toBeGreaterThan(0);
    // Downloadable, and a finished export never changes again.
    expect(interval?.({ state: { data: row("e1", "ready", "one") } })).toBe(
      false,
    );
    // A failed export is settled too — polling a dead row forever is the same
    // bug in the other direction.
    expect(interval?.({ state: { data: row("e1", "failed", "one") } })).toBe(
      false,
    );
  });
});
