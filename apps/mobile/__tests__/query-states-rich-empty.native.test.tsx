import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { Text } from "react-native";

import type { EmptyStateContent } from "@postwave/onboarding-schema";

import { QueryStates } from "@/components/QueryStates";
import { CampaignListEmpty } from "../src/components/campaigns/CampaignListEmpty";

jest.mock("@postwave/onboarding-schema", () => ({
  // onboarding-schema and telemetry share the route-test package shim, so the
  // local catalogue override must retain telemetry's canonical event surface.
  EVENTS: new Proxy({}, { get: (_target, property) => String(property) }),
  EMPTY_STATES: {
    campaigns: {
      id: "campaigns",
      title: "Send something worth opening",
      subtitle:
        "Draft a campaign with AI subject suggestions and send-time optimization.",
      illustrationKey: "campaigns",
      surfaceRouteKey: "campaigns",
      primaryCta: {
        label: "Create a campaign",
        routeKey: "campaigns.new",
      },
    },
  },
}));

const SUCCESSFUL_EMPTY_QUERY = {
  isError: false,
  isLoading: false,
  isFetching: false,
  isSuccess: true,
} as const;

const RICH_CONTENT: EmptyStateContent = {
  id: "campaigns",
  title: "A useful empty state",
  subtitle: "Choose the real next step instead of stopping here.",
  illustrationKey: "campaigns",
  primaryCta: {
    label: "Start a campaign",
    routeKey: "campaigns.new",
  },
  secondaryCta: {
    label: "Review forms",
    routeKey: "forms",
    variant: "secondary",
  },
};

function campaignEmptyProps(canCreate: boolean) {
  return {
    isError: false,
    error: null,
    onRetry: jest.fn(),
    firstLoad: false,
    gateNotice: null,
    filter: "all" as const,
    query: "",
    draining: false,
    capped: false,
    autoPageLimit: 5,
    onLoadMore: jest.fn(),
    canCreate,
    onCreate: jest.fn(),
  };
}

describe("QueryStates rich empty content", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("forwards shared content and exposes both CTAs as named buttons", async () => {
    await render(
      <QueryStates
        query={SUCCESSFUL_EMPTY_QUERY}
        isEmpty
        empty={{ content: RICH_CONTENT }}
      >
        <Text>Loaded rows</Text>
      </QueryStates>,
    );

    expect(screen.getByText(RICH_CONTENT.title)).toBeTruthy();
    expect(screen.getByText(RICH_CONTENT.subtitle)).toBeTruthy();
    const primary = screen.getByRole("button", { name: "Start a campaign" });
    const secondary = screen.getByRole("button", { name: "Review forms" });
    expect(primary.props.accessibilityLabel).toBe("Start a campaign");
    expect(secondary.props.accessibilityLabel).toBe("Review forms");

    fireEvent.press(primary);
    expect(router.push).toHaveBeenCalledWith("/(tabs)/campaigns?new=1");
  });

  it("preserves the existing bare title, description, and callback model", async () => {
    const onPress = jest.fn();
    await render(
      <QueryStates
        query={SUCCESSFUL_EMPTY_QUERY}
        isEmpty
        empty={{
          title: "No tags yet",
          description: "Create one when it helps organize the list.",
          cta: { label: "Create a tag", onPress },
        }}
      >
        <Text>Loaded rows</Text>
      </QueryStates>,
    );

    expect(screen.getByText("No tags yet")).toBeTruthy();
    expect(
      screen.getByText("Create one when it helps organize the list."),
    ).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Create a tag" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("keeps the fallback used by callers that omit empty copy", async () => {
    await render(
      <QueryStates query={SUCCESSFUL_EMPTY_QUERY} isEmpty>
        <Text>Loaded rows</Text>
      </QueryStates>,
    );

    expect(screen.getByText("Nothing here yet")).toBeTruthy();
  });
});

/**
 * A first fetch that TanStack PAUSED for want of a connection. The session is
 * still validated, so the auth gate stays open — but the query never ran:
 * `status: 'pending'`, `fetchStatus: 'paused'`, which v5 reports as
 * isPending:true, isPaused:true and (because isLoading = isPending &&
 * isFetching) isLoading:false. Nothing about it is an answer from the server.
 */
const PAUSED_FIRST_FETCH = {
  isError: false,
  isLoading: false,
  isFetching: false,
  isPending: true,
  isPaused: true,
} as const;

const DEFAULT_OFFLINE_COPY =
  /You're offline and this hasn't been cached yet\. It'll load when you reconnect\./u;

describe("QueryStates paused first fetch", () => {
  it("says the device is offline — not 'nothing here' — when the first fetch is paused", async () => {
    await render(
      <QueryStates
        query={PAUSED_FIRST_FETCH}
        isEmpty
        gate={{ enabled: true }}
        empty={{ title: "Nothing importing" }}
      >
        <Text>Loaded rows</Text>
      </QueryStates>,
    );

    expect(screen.getByText(DEFAULT_OFFLINE_COPY)).toBeTruthy();
    expect(screen.queryByText("Nothing importing")).toBeNull();
    expect(screen.queryByText("Loaded rows")).toBeNull();
  });

  it("uses the screen's own offline sentence for a paused first fetch", async () => {
    await render(
      <QueryStates
        query={PAUSED_FIRST_FETCH}
        isEmpty
        gate={{ enabled: true }}
        offlineMessage="Reconnect to load SCIM tokens."
        empty={{ title: "No provisioning tokens" }}
      >
        {null}
      </QueryStates>,
    );

    expect(screen.getByText("Reconnect to load SCIM tokens.")).toBeTruthy();
    expect(screen.queryByText("No provisioning tokens")).toBeNull();
    expect(screen.queryByText(DEFAULT_OFFLINE_COPY)).toBeNull();
  });

  it("keeps a cached, genuinely empty answer while a later refetch is paused", async () => {
    await render(
      <QueryStates
        query={{
          isError: false,
          isLoading: false,
          isFetching: false,
          isSuccess: true,
          isPending: false,
          isPaused: true,
        }}
        isEmpty
        gate={{ enabled: true }}
        empty={{ title: "Nothing importing" }}
      >
        <Text>Loaded rows</Text>
      </QueryStates>,
    );

    expect(screen.getByText("Nothing importing")).toBeTruthy();
    expect(screen.queryByText(DEFAULT_OFFLINE_COPY)).toBeNull();
  });

  it("still renders rows the caller already holds while the fetch is paused", async () => {
    await render(
      <QueryStates
        query={PAUSED_FIRST_FETCH}
        isEmpty={false}
        gate={{ enabled: true }}
        empty={{ title: "Nothing importing" }}
      >
        <Text>Loaded rows</Text>
      </QueryStates>,
    );

    expect(screen.getByText("Loaded rows")).toBeTruthy();
    expect(screen.queryByText(DEFAULT_OFFLINE_COPY)).toBeNull();
  });

  it("does not treat a disabled (idle, never-paused) pending query as offline", async () => {
    await render(
      <QueryStates
        query={{ ...PAUSED_FIRST_FETCH, isPaused: false }}
        isEmpty
        gate={{ enabled: true }}
        empty={{ title: "Nothing importing" }}
      >
        {null}
      </QueryStates>,
    );

    expect(screen.getByText("Nothing importing")).toBeTruthy();
    expect(screen.queryByText(DEFAULT_OFFLINE_COPY)).toBeNull();
  });
});

describe("campaign list rich empty state", () => {
  it("offers the shared create action only when mobile may create", async () => {
    const props = campaignEmptyProps(true);
    await render(<CampaignListEmpty {...props} />);

    expect(screen.getByText("Send something worth opening")).toBeTruthy();
    const action = screen.getByRole("button", { name: "Create a campaign" });
    expect(action.props.accessibilityLabel).toBe("Create a campaign");
    fireEvent.press(action);
    expect(router.push).toHaveBeenCalledWith("/(tabs)/campaigns?new=1");
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("keeps viewers on the honest bare state with no create CTA", async () => {
    await render(<CampaignListEmpty {...campaignEmptyProps(false)} />);

    expect(screen.getByText("No campaigns yet")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Create a campaign" }),
    ).toBeNull();
  });
});
