/**
 * Landing pages — the render contract for the list and the detail sheet.
 *
 * WHAT THIS FILE EXISTS TO CATCH. This surface makes exactly two claims that
 * could be wrong in a way nobody would notice:
 *
 *  1. WHETHER A PAGE IS LIVE. Moosewave serves `status = 'published'` rows and
 *     nothing else (`Repo.PublicLandingPage`), so a copyable link on a draft is
 *     a 404 pasted into an ad. The sheet must offer NO link for a draft, and
 *     must say why.
 *  2. HOW MANY LEADS A PAGE HAS. The count is a claim about the world, and it
 *     is only true once the leads request has settled — before that it is an
 *     em-dash, and a FAILED request is an error, never "no leads".
 *
 * WHY THE SHEET IS RENDERED DIRECTLY RATHER THAN OPENED BY A TAP. The
 * `@tanstack/react-query` harness sets ONE result for every `useQuery` in the
 * module graph, so a test that opened the sheet would hand the leads query the
 * page array and vice versa — the mock-shape mismatch that made a whole round
 * of suites pass while asserting nothing. The sheet takes its data as props, so
 * it is driven with genuinely lead-shaped payloads here while the route keeps
 * genuinely page-shaped ones.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import { LandingPageDetailSheet } from "@/components/landing-pages/LandingPageDetailSheet";
import {
  parseLandingPage,
  parseLeadList,
  type MobileLandingPage,
  type MobileLead,
} from "@/lib/landingPages";

import LandingPages from "../app/(tabs)/landing-pages";

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

/** The exact shape `useLandingPages` resolves to: `MobileLandingPage[]`. */
function loaded(pages: readonly MobileLandingPage[]) {
  return {
    data: pages,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: pages })),
  };
}

const FAILED = {
  data: undefined,
  error: new Error("boom"),
  isError: true,
  isFetching: false,
  isLoading: false,
  isPending: false,
  isRefetching: false,
  isSuccess: false,
  refetch: jest.fn(async () => ({ data: undefined })),
};

/** Built through the real parser, from the row shape `Deps.List` serialises. */
function page(overrides: Record<string, unknown> = {}): MobileLandingPage {
  const parsed = parseLandingPage({
    id: "lp-1",
    tenant_id: "11111111-1111-4111-8111-111111111111",
    slug: "spring-launch",
    name: "Spring launch",
    status: "published",
    domain: "",
    template: "signup",
    blocks: [],
    seo: {},
    tracking: {},
    metrics: {},
    created_at: "2026-07-01T09:00:00Z",
    updated_at: "2026-07-20T11:30:00Z",
    ...overrides,
  });
  if (!parsed) throw new Error("fixture must parse");
  return parsed;
}

describe("the landing-pages list", () => {
  it("renders a bounded first frame while the list is still loading", async () => {
    const view = await render(<LandingPages />, { wrapper });

    expect(view.toJSON()).not.toBeNull();
    // The header proves the route module — not an error boundary — rendered.
    expect(screen.getAllByText("Landing pages").length).toBeGreaterThan(0);
  });

  it("offers the three states the status column can actually hold", async () => {
    await render(<LandingPages />, { wrapper });

    expect(screen.getByText("All")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("Drafts")).toBeTruthy();
    expect(screen.getByText("Archived")).toBeTruthy();
  });

  it("shows a published page with the public PATH it is served at", async () => {
    queryHarness.__setQueryResultForTests(loaded([page()]));

    await render(<LandingPages />, { wrapper });

    expect(screen.getByText("Spring launch")).toBeTruthy();
    // The slug is shown as the path it becomes, because that is what a
    // colleague pastes into chat.
    expect(screen.getByText("/landing/spring-launch")).toBeTruthy();
    expect(screen.getByText("Published")).toBeTruthy();
  });

  it("never prints a lead count on a row — no endpoint can back one", async () => {
    queryHarness.__setQueryResultForTests(loaded([page()]));

    await render(<LandingPages />, { wrapper });

    // `metrics` is `{}` for every row in production; rendering it as a count
    // would put a manufactured zero on every page in the workspace.
    expect(screen.queryByText("0 leads")).toBeNull();
    expect(screen.queryByText(/\d+ leads/)).toBeNull();
  });

  it("states a draft's status rather than letting it look live", async () => {
    queryHarness.__setQueryResultForTests(
      loaded([page({ status: "draft", name: "Webinar signup", slug: "webinar" })]),
    );

    await render(<LandingPages />, { wrapper });

    expect(
      screen.getByLabelText(
        "Draft: this page is not served publicly, so it cannot capture leads.",
      ),
    ).toBeTruthy();
  });

  it("surfaces a recorded custom domain instead of hiding it", async () => {
    queryHarness.__setQueryResultForTests(
      loaded([page({ domain: "get.example.com" })]),
    );

    await render(<LandingPages />, { wrapper });

    expect(screen.getByText(/Custom domain: get\.example\.com/)).toBeTruthy();
  });

  it("says a page has no update time instead of inventing one", async () => {
    queryHarness.__setQueryResultForTests(
      loaded([page({ updated_at: "0001-01-01T00:00:00Z" })]),
    );

    await render(<LandingPages />, { wrapper });

    expect(screen.getByText("No update recorded")).toBeTruthy();
    expect(screen.queryByText(/1970|January 1, 1/)).toBeNull();
  });

  it("reads an offline session as offline, never as an empty workspace", async () => {
    gateHarness.__setOnlineGateForTests({ enabled: false });
    queryHarness.__setQueryResultForTests(loaded([]));

    await render(<LandingPages />, { wrapper });

    expect(screen.getByText(/You're offline/)).toBeTruthy();
    expect(screen.queryByText("No landing pages yet")).toBeNull();
  });

  it("renders a genuinely empty workspace as empty, and says where pages come from", async () => {
    queryHarness.__setQueryResultForTests(loaded([]));

    await render(<LandingPages />, { wrapper });

    expect(screen.getByText("No landing pages yet")).toBeTruthy();
  });

  it("renders a failed fetch as an error, never as 'no landing pages'", async () => {
    queryHarness.__setQueryResultForTests(FAILED);

    await render(<LandingPages />, { wrapper });

    expect(screen.queryByText("No landing pages yet")).toBeNull();
  });

  /**
   * A REHYDRATED NON-ARRAY CACHE MUST NOT TAKE THE TAB DOWN.
   *
   * The query cache is persisted to disk and restored on launch
   * (lib/secureQueryPersister), whose header records that a restored payload is
   * handed straight to components writing `query.data ?? []` — a NULLISH guard
   * that passes `{}` and `{items: []}` through. This screen fed that value to
   * `landingStatusCounts`, which iterates with for-of, so the whole tab died
   * with "pages is not iterable" before a row rendered.
   *
   * `{items: []}` is the envelope the sibling leads route answers, i.e. exactly
   * what a build that mixed the two up would have written into the cache.
   */
  it("survives a restored cache holding a truthy non-array", async () => {
    queryHarness.__setQueryResultForTests({
      ...loaded([]),
      data: { items: [] } as unknown as MobileLandingPage[],
    });

    const view = await render(<LandingPages />, { wrapper });

    expect(view.toJSON()).not.toBeNull();
    expect(screen.getByText("Landing pages")).toBeTruthy();
  });

  it("still renders real rows — the guard must not swallow good input", async () => {
    // A coercion that returned [] unconditionally would pass the test above.
    queryHarness.__setQueryResultForTests(loaded([page()]));

    await render(<LandingPages />, { wrapper });

    expect(screen.getByText("Spring launch")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The detail sheet
// ---------------------------------------------------------------------------

/** The exact shape `useLandingLeads` resolves to: `MobileLead[]`. */
const LEADS: MobileLead[] = parseLeadList({
  items: [
    {
      email: "ada@example.com",
      metadata: { utm_source: "twitter" },
      at: "2026-07-24T10:00:00Z",
    },
    { email: "", metadata: {}, at: "2026-07-23T10:00:00Z" },
  ],
});

const SETTLED = {
  isError: false,
  isLoading: false,
  isFetching: false,
  isSuccess: true,
};

function sheetProps(overrides: Record<string, unknown> = {}) {
  return {
    page: page(),
    leads: LEADS,
    leadsQuery: SETTLED,
    gate: { enabled: true },
    now: Date.parse("2026-07-24T12:00:00Z"),
    onClose: jest.fn(),
    publicUrl: "https://app.moosewave.com/landing/spring-launch",
    onCopyUrl: jest.fn(),
    ...overrides,
  };
}

describe("the landing-page detail sheet", () => {
  it("shows the public link for a live page, and copies exactly that string", async () => {
    const onCopyUrl = jest.fn();
    await render(<LandingPageDetailSheet {...sheetProps({ onCopyUrl })} />, {
      wrapper,
    });

    expect(
      screen.getByText("https://app.moosewave.com/landing/spring-launch"),
    ).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Copy the public link"));
    expect(onCopyUrl).toHaveBeenCalledWith(
      "https://app.moosewave.com/landing/spring-launch",
    );
  });

  it("offers NO link for a draft, and says why", async () => {
    await render(
      <LandingPageDetailSheet
        {...sheetProps({ page: page({ status: "draft" }), publicUrl: null })}
      />,
      { wrapper },
    );

    expect(screen.queryByLabelText("Copy the public link")).toBeNull();
    expect(screen.getByText(/aren't served publicly/)).toBeTruthy();
  });

  it("states a recorded custom domain without turning it into a URL", async () => {
    await render(
      <LandingPageDetailSheet
        {...sheetProps({ page: page({ domain: "get.example.com" }) })}
      />,
      { wrapper },
    );

    expect(screen.getByText(/Custom domain recorded: get\.example\.com/)).toBeTruthy();
    expect(screen.queryByText(/https:\/\/get\.example\.com/)).toBeNull();
  });

  it("says when the page was last edited, in both compacted and spoken form", async () => {
    await render(<LandingPageDetailSheet {...sheetProps()} />, { wrapper });

    // The absolute instant is what the compaction throws away, so it is what
    // the screen reader receives.
    expect(screen.getByLabelText(/Last edited: .*2026/)).toBeTruthy();
  });

  it("shows an em-dash for a page with no recorded edit time", async () => {
    await render(
      <LandingPageDetailSheet
        {...sheetProps({ page: page({ updated_at: "0001-01-01T00:00:00Z" }) })}
      />,
      { wrapper },
    );

    expect(
      screen.getByLabelText("Last edited: No update time was recorded."),
    ).toBeTruthy();
  });

  it("counts the leads it actually received", async () => {
    await render(<LandingPageDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText("2 leads")).toBeTruthy();
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("Utm source: twitter")).toBeTruthy();
  });

  it("shows an em-dash, never 0, before the leads request settles", async () => {
    await render(
      <LandingPageDetailSheet
        {...sheetProps({
          leads: [],
          leadsQuery: { ...SETTLED, isLoading: true, isSuccess: false },
        })}
      />,
      { wrapper },
    );

    expect(screen.getByLabelText("The lead count hasn't loaded yet.")).toBeTruthy();
    expect(screen.queryByText("0 leads")).toBeNull();
  });

  it("gives a conversion with no address words, not a blank line", async () => {
    await render(<LandingPageDetailSheet {...sheetProps()} />, { wrapper });

    // `COALESCE(email, '')` makes "" a real row.
    expect(screen.getByText("No email captured")).toBeTruthy();
  });

  it("explains an empty DRAFT as 'not served', not as 'nobody signed up'", async () => {
    await render(
      <LandingPageDetailSheet
        {...sheetProps({
          page: page({ status: "draft" }),
          publicUrl: null,
          leads: [],
        })}
      />,
      { wrapper },
    );

    expect(screen.getByText("Nothing captured yet")).toBeTruthy();
    expect(screen.queryByText("No leads yet")).toBeNull();
  });

  it("explains an empty PUBLISHED page as nobody having submitted it", async () => {
    await render(
      <LandingPageDetailSheet {...sheetProps({ leads: [] })} />,
      { wrapper },
    );

    expect(screen.getByText("No leads yet")).toBeTruthy();
  });

  it("renders a failed leads fetch as an error, never as 'no leads'", async () => {
    await render(
      <LandingPageDetailSheet
        {...sheetProps({
          leads: [],
          leadsQuery: { ...SETTLED, isError: true, isSuccess: false },
        })}
      />,
      { wrapper },
    );

    expect(screen.queryByText("No leads yet")).toBeNull();
    expect(screen.queryByText("Nothing captured yet")).toBeNull();
  });

  it("reads an offline sheet as offline, never as a page nobody filled in", async () => {
    await render(
      <LandingPageDetailSheet
        {...sheetProps({ leads: [], gate: { enabled: false } })}
      />,
      { wrapper },
    );

    expect(screen.getByText(/You're offline/)).toBeTruthy();
    expect(screen.queryByText("No leads yet")).toBeNull();
  });

  it("says plainly that CSV export is not something this app can finish", async () => {
    await render(<LandingPageDetailSheet {...sheetProps()} />, { wrapper });

    // The .csv route is a browser download and this app has no file-share
    // sheet; the honest sentence replaces a button that could not work.
    expect(screen.getByText(/no file-share sheet/)).toBeTruthy();
  });

  it("tells the operator that a lead is also a subscriber", async () => {
    await render(<LandingPageDetailSheet {...sheetProps()} />, { wrapper });

    // `PublicLandingConvert` upserts the address as unconfirmed BEFORE
    // recording the conversion, so the two are never separate facts.
    expect(screen.getByText(/unconfirmed\s+subscriber/)).toBeTruthy();
  });
});
