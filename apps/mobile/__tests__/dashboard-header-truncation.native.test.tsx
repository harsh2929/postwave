/**
 * Two defects reproduced on the dashboard by driving the real app, both about
 * the header telling the reader something untrue.
 *
 * F06a — "Share" CLIPPED TO "Shaı" at accessibility-extra-extra-extra-large.
 * `ScreenHeader`'s right slot is `flexShrink: 1` with `maxWidth: "58%"`; the
 * share button was the default `flexShrink: 0`, so at the largest Dynamic Type
 * sizes it overflowed the clamped slot, ran off the trailing screen edge and
 * was cut mid-glyph. A single word cannot wrap out of that, so the button must
 * yield width and the label must shrink to fit what is left — while keeping
 * the 44pt target and the full `accessibilityLabel`, which are the two things
 * a "just make it smaller" fix would quietly cost.
 *
 * F06b — THE FRESHNESS PILL CONTRADICTED THE ERROR. With the API unreachable
 * the dashboard showed "LOADING" beside "Something went wrong loading the
 * dashboard. Please try again." for over two and a half minutes. The badge is
 * asserted here at the render layer; `lib/dashboardLiveness.test.ts` pins the
 * rule underneath it.
 */
import { describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";

import { DashboardHeaderActions } from "@/components/dashboard/DashboardHeaderActions";
import { LiveDot } from "@/components/dashboard/LiveDot";

const NOW = 1_800_000_000_000;

/** Complete enough for `canBuildDashboardSnapshot`, so the button renders. */
const STATS = {
  subscribers_total: 12_480,
  subscribers_added_30d: 148,
  subscribers_unsubbed_30d: 28,
  unique_opens_30d: 300,
  unique_delivered_30d: 1000,
  unique_sent_30d: 1010,
  unique_clicks_30d: 40,
  unique_bounces_30d: 10,
  campaigns_sent_30d: 4,
  active_sequences_count: 2,
  recent_audit: [],
};

function flattenedStyle(node: { props: { style?: unknown } }) {
  return StyleSheet.flatten(node.props.style as never) as Record<
    string,
    unknown
  >;
}

const SHARE_LABEL = "Share a workspace snapshot for Last 30 days";

async function renderShare() {
  return render(
    <DashboardHeaderActions
      stats={STATS}
      workspaceName="Acme"
      rangeLabel="Last 30 days"
    />,
  );
}

describe("dashboard share action at large Dynamic Type", () => {
  it("shrinks the label to fit instead of clipping it mid-glyph", async () => {
    const view = await renderShare();
    const label = view.getByText("Share");

    // Without both of these the single word overflows its box and the glyph
    // run is cut, which is exactly what was photographed on device.
    expect(label.props.numberOfLines).toBe(1);
    expect(label.props.adjustsFontSizeToFit).toBe(true);
    expect(label.props.minimumFontScale).toBeLessThan(1);
    // A fixed `lineHeight` fights the shrink pass, so the label must take the
    // bare size rather than the full `typeStyle`.
    expect(flattenedStyle(label).lineHeight).toBeUndefined();
  });

  it("lets the button yield width without giving up the 44pt target", async () => {
    const view = await renderShare();
    const button = view.getByRole("button", { name: SHARE_LABEL });
    const style = flattenedStyle(button);

    expect(style.flexShrink).toBe(1);
    // Flex never takes a box below its `minWidth`, so this is what makes the
    // shrink safe rather than merely smaller.
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  });

  it("keeps the whole spoken label, however small the glyphs get", async () => {
    const view = await renderShare();
    expect(view.getByRole("button", { name: SHARE_LABEL })).toBeTruthy();
  });
});

describe("dashboard freshness pill on a failed first load", () => {
  it("does not claim to be loading while the screen shows a load failure", async () => {
    const view = await render(
      <LiveDot lastUpdatedAt={0} now={NOW} errored stream="off" />,
    );

    expect(view.queryByText("Loading")).toBeNull();
    expect(view.getByText("Load failed")).toBeTruthy();
    expect(
      view.getByLabelText("Dashboard could not load. No figures are shown"),
    ).toBeTruthy();
  });

  it("still says Loading while a first load is genuinely in flight", async () => {
    const view = await render(
      <LiveDot lastUpdatedAt={0} now={NOW} stream="off" />,
    );

    expect(view.getByText("Loading")).toBeTruthy();
  });
});
