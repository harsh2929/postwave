/** Native proof that Agency is read-only and explicitly cursor-paged. */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AccessibilityInfo, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import Agency from "../app/(tabs)/agency";
import { SectionLabel } from "../src/components/SectionLabel";
import { AgencyReleaseStatus } from "../src/components/agency/AgencyReleaseStatus";
import { BrandingCard } from "../src/components/agency/BrandingCard";
import { ChildrenSection } from "../src/components/agency/ChildrenSection";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const queryHooks = require("./mocks/queryHooks.cjs") as {
  __setHookResultForTests: (name: string, value: unknown) => void;
  __resetHookResultsForTests: () => void;
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

/**
 * The shared theme mock answers "#777777" for EVERY token, so under it a
 * heading painted fgSubtle and one painted fgMuted are indistinguishable.
 * This file tells those two apart (the light palette's pair; CQ-8 below) and
 * leaves every other token on the shared mock's answer.
 */
jest.mock("@/lib/theme", () => {
  const base = jest.requireActual("./mocks/theme.cjs") as {
    useTheme: () => Record<string, unknown>;
  };
  const tokens = new Proxy({} as Record<string, string>, {
    get: (_target, key) =>
      key === "fgMuted"
        ? "#5C5C5C"
        : key === "fgSubtle"
          ? "#7A766C"
          : "#777777",
  });
  return { ...base, useTheme: () => ({ ...base.useTheme(), t: tokens }) };
});

const CHILD = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme",
  name: "Acme",
  tier: "studio" as const,
  parent_tenant_id: "22222222-2222-4222-8222-222222222222",
  billing_mode: "parent" as const,
  reseller_markup_bps: 250,
  whitelabel_enabled: false,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-02T00:00:00.000Z",
};

const BRANDING = {
  whitelabel_enabled: true,
  brand_name: "Acme Agency",
  custom_domain: "mail.acme.co",
  logo_url: "https://cdn.acme.co/logo.svg",
  primary_color: "#1D4ED8",
  support_email: "help@acme.co",
  legal_entity: "Acme LLC",
  updated_at: "2026-08-02T00:00:00.000Z",
  etag: '"agency-branding:22222222-2222-4222-8222-222222222222:v1"',
};

function renderInApp(element: React.ReactElement) {
  return render(element, {
    wrapper: ({ children }: { children: ReactNode }) => (
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

afterEach(() => {
  jest.clearAllMocks();
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

/**
 * The overview hook as the SCREEN sees it: loaded, one child, another page
 * available. The ChildrenSection cases below hand-write their props, so they
 * cannot catch the route forwarding the wrong paging facts; these render
 * app/(tabs)/agency and let it compute them.
 */
function pagedOverview(isFetchNextPageError: boolean) {
  const fetchNextPage = jest.fn(async () => undefined);
  queryHooks.__setHookResultForTests("useMobileAgencyOverview", {
    data: {
      branding: BRANDING,
      children: [CHILD],
      notAgency: false,
      accessRestricted: false,
      brandingUnavailable: false,
      childrenUnavailable: false,
      errors: [],
    },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    hasNextPage: true,
    isFetchingNextPage: false,
    isFetchNextPageError,
    fetchNextPage,
    refetch: jest.fn(async () => undefined),
  });
  return fetchNextPage;
}

describe("agency screen roster paging", () => {
  it("offers a retry for a failed next page and says the loaded rows still stand", async () => {
    const fetchNextPage = pagedOverview(true);
    const view = await renderInApp(<Agency />);

    expect(
      view.getByText(/The next roster page could not be loaded\./u),
    ).toBeTruthy();
    const retry = view.getByLabelText(
      "Retry loading the next child-workspace page",
    );
    expect(retry.props.accessibilityState?.disabled).toBe(false);
    expect(view.getByText("Retry next page")).toBeTruthy();

    fireEvent.press(retry);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("speaks a failed next page on iOS, where the alert role alone is silent (A11Y-3)", async () => {
    const spoken = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    try {
      const props = {
        rows: [CHILD],
        notAgency: false,
        accessRestricted: false,
        unavailable: false,
        hasMore: true,
        canLoadMore: true,
        isFetchingNextPage: false,
        onLoadMore: jest.fn(),
      };
      const view = await renderInApp(
        <ChildrenSection {...props} isNextPageError={false} />,
      );
      // Vacuity floor: a healthy roster announces nothing about paging.
      expect(spoken).not.toHaveBeenCalledWith(
        expect.stringContaining("next roster page"),
      );

      await view.rerender(<ChildrenSection {...props} isNextPageError />);
      expect(spoken).toHaveBeenCalledWith(
        "The next roster page could not be loaded. The verified rows above are still shown.",
      );
    } finally {
      spoken.mockRestore();
    }
  });

  it("keeps load-more inert, on the real screen, once the online gate closes", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });
    const fetchNextPage = pagedOverview(false);
    const view = await renderInApp(<Agency />);

    const control = view.getByLabelText(
      "Reconnect to load more child workspaces",
    );
    expect(control.props.accessibilityState?.disabled).toBe(true);
    expect(view.queryByLabelText("Load more child workspaces")).toBeNull();

    fireEvent.press(control);
    expect(fetchNextPage).not.toHaveBeenCalled();
  });
});

describe("agency native release boundary", () => {
  it("offers only explicit roster paging and no lifecycle or billing action", async () => {
    const loadMore = jest.fn();
    const view = await renderInApp(
      <ChildrenSection
        rows={[CHILD]}
        notAgency={false}
        accessRestricted={false}
        unavailable={false}
        hasMore
        canLoadMore
        isFetchingNextPage={false}
        isNextPageError={false}
        onLoadMore={loadMore}
      />,
    );

    expect(view.getByText("1 loaded")).toBeTruthy();
    expect(view.queryByLabelText(/create .*workspace/i)).toBeNull();
    expect(view.queryByLabelText(/unlink Acme/i)).toBeNull();
    expect(view.queryByLabelText(/make Acme .*billed/i)).toBeNull();
    expect(view.queryByText(/invoice total/i)).toBeNull();

    fireEvent.press(view.getByLabelText("Show stored details for Acme"));
    expect(await view.findByText(/no payer transfer/i)).toBeTruthy();
    expect(view.getAllByText("Agency (stored)")).toHaveLength(2);

    fireEvent.press(view.getByLabelText("Load more child workspaces"));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("keeps cached pagination inert after the online authority gate closes", async () => {
    const loadMore = jest.fn();
    const view = await renderInApp(
      <ChildrenSection
        rows={[CHILD]}
        notAgency={false}
        accessRestricted={false}
        unavailable={false}
        hasMore
        canLoadMore={false}
        isFetchingNextPage={false}
        isNextPageError={false}
        onLoadMore={loadMore}
      />,
    );

    const control = view.getByLabelText(
      "Reconnect to load more child workspaces",
    );
    expect(control.props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(control);
    expect(loadMore).not.toHaveBeenCalled();
    expect(view.getByText("Reconnect to load more")).toBeTruthy();
  });

  it("renders every branding value as stored or unpublished and no editor", async () => {
    const view = await renderInApp(<BrandingCard branding={BRANDING} />);

    expect(view.getByText("Publishing held")).toBeTruthy();
    expect(view.getByText("mail.acme.co · unpublished")).toBeTruthy();
    expect(view.getByText("Acme LLC · unpublished")).toBeTruthy();
    expect(view.queryByLabelText(/edit .*branding/i)).toBeNull();

    await view.rerender(
      <BrandingCard
        branding={{
          ...BRANDING,
          brand_name: "Second principal",
          custom_domain: "legacy.second.co",
          etag: '"agency-branding:22222222-2222-4222-8222-222222222222:v2"',
        }}
      />,
    );
    expect(view.getByText("Second principal")).toBeTruthy();
    expect(view.queryByText("Acme Agency")).toBeNull();
    expect(view.queryByLabelText(/edit .*branding/i)).toBeNull();
  });

  it("names all five held capabilities without exposing a request control", async () => {
    const view = await renderInApp(<AgencyReleaseStatus />);

    expect(view.getByText("5 held")).toBeTruthy();
    expect(view.getByText("Create a child workspace")).toBeTruthy();
    expect(view.getByText("Unlink a child workspace")).toBeTruthy();
    expect(view.getByText("Change the stored billing owner")).toBeTruthy();
    expect(view.getByText("Preview consolidated billing")).toBeTruthy();
    expect(view.getByText("Publish audit portal branding")).toBeTruthy();
    expect(view.queryAllByRole("button")).toHaveLength(0);
  });
});

/**
 * CQ-8. The agency headings came from a private `sectionLabel(t)` factory
 * that had already drifted from the shared <SectionLabel>: fgSubtle instead of
 * fgMuted (4.41:1 against 6.51:1 on the light page, on 11pt text) and
 * letterSpacing 0.5 instead of 0.6. A change to the shell heading never
 * reached this screen. The comparison is against the shared component, not
 * literals, so it follows SectionLabel wherever that goes next.
 */
describe("agency section headings", () => {
  async function referenceHeading() {
    const view = await renderInApp(<SectionLabel>Reference</SectionLabel>);
    const style = StyleSheet.flatten(
      view.getByRole("header", { name: "Reference" }).props.style,
    );
    await view.unmount();
    // Vacuity floor: the override above took effect, so a colour match
    // below is a real match and not two "#777777"s agreeing.
    expect(style.color).toBe("#5C5C5C");
    return style;
  }

  function headingStyle(
    view: Awaited<ReturnType<typeof renderInApp>>,
    name: string,
  ) {
    return StyleSheet.flatten(view.getByRole("header", { name }).props.style);
  }

  it("titles the child roster with the shared section heading", async () => {
    const reference = await referenceHeading();
    const view = await renderInApp(
      <ChildrenSection
        rows={[]}
        notAgency={false}
        accessRestricted={false}
        unavailable={false}
        hasMore={false}
        canLoadMore
        isFetchingNextPage={false}
        isNextPageError={false}
        onLoadMore={() => undefined}
      />,
    );

    const heading = headingStyle(view, "Child workspaces");
    expect(heading.color).toBe(reference.color);
    expect(heading.letterSpacing).toBe(reference.letterSpacing);
    expect(heading).toEqual(reference);
    // The pills moved into the heading's right slot, not into its name.
    expect(view.getByText("lifecycle held")).toBeTruthy();
  });

  it("titles every section on the real screen the same way", async () => {
    const reference = await referenceHeading();
    pagedOverview(false);
    const view = await renderInApp(<Agency />);

    for (const name of [
      "Child workspaces",
      "Audit portal branding",
      "Release status",
    ]) {
      const heading = headingStyle(view, name);
      expect({ name, color: heading.color }).toEqual({
        name,
        color: reference.color,
      });
      expect({ name, letterSpacing: heading.letterSpacing }).toEqual({
        name,
        letterSpacing: reference.letterSpacing,
      });
      expect(heading).toEqual(reference);
    }
    expect(view.getByText("1 loaded")).toBeTruthy();
  });
});
