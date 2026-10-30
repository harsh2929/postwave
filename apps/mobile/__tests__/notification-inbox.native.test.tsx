import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

// SwipeableRow renders gesture-handler's ReanimatedSwipeable, which reaches
// for parts of the reanimated API the node harness does not emulate. The
// subject here is the inbox's DAY GROUPING, so the wrapper degrades to a
// passthrough — it keeps rendering its children, which is the only thing the
// assertions below depend on.
jest.mock("@/components/SwipeableRow", () => ({
  SwipeableRow: ({ children }: { children: React.ReactNode }) => children,
}));

import NotificationsScreen from "../app/(tabs)/notifications";
import SearchScreen from "../app/(tabs)/search";

const {
  __setQueryResultForTests,
  __resetQueryResultForTests,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./mocks/reactQuery.cjs");

/**
 * The inbox was a flat FlatList where every row carried a relative timestamp,
 * so "what happened today" meant reading forty rows and doing the arithmetic.
 * It is a SectionList with day boundaries now, and those boundaries are the
 * thing a VoiceOver user navigates by — so this pins them as real headers,
 * not just larger grey text.
 */

const SETTLED_AT = new Date(2026, 6, 25, 14, 0).getTime();

function feed(items: unknown[]) {
  return {
    data: { items, unread_count: 1 },
    dataUpdatedAt: SETTLED_AT,
    error: null,
    fetchNextPage: async () => undefined,
    hasNextPage: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: async () => ({ data: undefined }),
  };
}

function mount(Component: React.ComponentType) {
  return render(React.createElement(Component), {
    wrapper: ({ children }) => (
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        {children}
      </SafeAreaProvider>
    ),
  });
}

describe("notification inbox", () => {
  afterEach(() => {
    __resetQueryResultForTests();
  });

  it("groups the feed under day headings a screen reader can navigate by", async () => {
    __setQueryResultForTests(
      feed([
        {
          id: "n1",
          kind: "campaign.sent",
          title: "Spring sale sent",
          body: "12,480 recipients",
          created_at: new Date(2026, 6, 25, 9, 0).toISOString(),
          read_at: null,
          deep_link: null,
        },
        {
          id: "n2",
          kind: "campaign.sent",
          title: "Welcome series resumed",
          body: null,
          created_at: new Date(2026, 6, 24, 18, 0).toISOString(),
          read_at: new Date(2026, 6, 24, 19, 0).toISOString(),
          deep_link: null,
        },
      ]),
    );

    await mount(NotificationsScreen);

    // Real headers, so VoiceOver's rotor can jump between days.
    expect(screen.getByRole("header", { name: "Today" })).toBeTruthy();
    expect(screen.getByRole("header", { name: "Yesterday" })).toBeTruthy();
    // Both rows survived the regrouping.
    expect(screen.getByText("Spring sale sent")).toBeTruthy();
    expect(screen.getByText("Welcome series resumed")).toBeTruthy();
  });

  it("says UNREAD in words, not only in a coloured dot", async () => {
    __setQueryResultForTests(
      feed([
        {
          id: "n1",
          kind: "campaign.sent",
          title: "Spring sale sent",
          body: null,
          created_at: new Date(2026, 6, 25, 9, 0).toISOString(),
          read_at: null,
          deep_link: null,
        },
      ]),
    );

    await mount(NotificationsScreen);
    expect(screen.getByLabelText("Unread. Spring sale sent")).toBeTruthy();
  });

  it("never drops a row with an unusable timestamp", async () => {
    __setQueryResultForTests(
      feed([
        {
          id: "n1",
          kind: "system",
          title: "Undated notice",
          body: null,
          created_at: "not-a-date",
          read_at: null,
          deep_link: null,
        },
      ]),
    );

    await mount(NotificationsScreen);
    expect(screen.getByRole("header", { name: "Earlier" })).toBeTruthy();
    expect(screen.getByText("Undated notice")).toBeTruthy();
  });

  it("opens an inbound SMS topic on the list without trusting its web path", async () => {
    __setQueryResultForTests(
      feed([
        {
          id: "sms-1",
          kind: "sms.received",
          title: "New SMS received",
          body: "Hostile +14155550123 body\u202e",
          created_at: new Date(2026, 6, 25, 9, 0).toISOString(),
          read_at: null,
          deep_link: "/app/sms?tab=inbox&phone=%2B14155550123&body=Hostile",
        },
      ]),
    );

    await mount(NotificationsScreen);
    fireEvent.press(screen.getByLabelText("Unread. New SMS received"));

    expect(router.push).toHaveBeenCalledWith("/(tabs)/sms");
    expect(router.push).not.toHaveBeenCalledWith(
      expect.stringContaining("14155550123"),
    );
  });

  /**
   * The bell could not reach `NOTIFICATION_ROUTES` at all, so an operational
   * alert push routes correctly was a dead tap here — and because the screen
   * withholds the read receipt on an unresolved tap, the row kept its unread
   * dot too. Navigation is what is asserted; the receipt follows from it,
   * because the screen spends the receipt exactly when a route resolved.
   */
  it("routes an operational alert the push path has always routed", async () => {
    __setQueryResultForTests(
      feed([
        {
          id: "wh-1",
          kind: "webhook",
          event_type: "webhook.auto_disabled",
          title: "Webhook endpoint disabled",
          body: null,
          created_at: new Date(2026, 6, 25, 9, 0).toISOString(),
          read_at: null,
          // Relative and four segments deep — no mobile URL grammar accepted
          // it, which is why this tap did nothing.
          deep_link: "/app/settings/webhooks",
        },
      ]),
    );

    await mount(NotificationsScreen);
    fireEvent.press(screen.getByLabelText("Unread. Webhook endpoint disabled"));

    expect(router.push).toHaveBeenCalledWith("/(tabs)/webhooks");
  });

  it("lands a dashboard alert on the screen its relative link names", async () => {
    __setQueryResultForTests(
      feed([
        {
          id: "an-1",
          kind: "dashboard.anomaly",
          event_type: "dashboard.anomaly",
          title: "Open rate dropped",
          body: null,
          created_at: new Date(2026, 6, 25, 9, 0).toISOString(),
          read_at: null,
          deep_link: "/app/analytics",
        },
      ]),
    );

    await mount(NotificationsScreen);
    fireEvent.press(screen.getByLabelText("Unread. Open rate dropped"));

    expect(router.push).toHaveBeenCalledWith("/(tabs)/analytics");
  });
});

describe("search screen", () => {
  afterEach(() => {
    __resetQueryResultForTests();
  });

  it("renders a bounded state with the palette available before any query", async () => {
    await mount(SearchScreen);
    expect(screen.getByLabelText("Search Moosewave")).toBeTruthy();
  });
});
