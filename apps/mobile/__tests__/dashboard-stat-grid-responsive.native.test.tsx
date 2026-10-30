/**
 * The dashboard's headline grid is deliberately space-responsive rather than
 * device-named: a normal portrait iPad can scan six metrics in two rows, while
 * a phone and a tablet at large Dynamic Type retain the proven two-up reading
 * width. These assertions pin both the breakpoint policy and the geometry that
 * reaches React Native, including the loading state that precedes the cards.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";

const mockWindowDimensions = jest.fn(() => ({
  width: 390,
  height: 844,
  scale: 3,
  fontScale: 1,
}));

jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({
  __esModule: true,
  default: mockWindowDimensions,
}));

// eslint-disable-next-line import/first
import {
  DashboardStatGrid,
  dashboardStatGridColumns,
} from "@/components/dashboard/DashboardStatGrid";

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

function setWindow(width: number, fontScale = 1) {
  mockWindowDimensions.mockReturnValue({
    width,
    height: width >= 700 ? 1024 : 844,
    scale: width >= 700 ? 2 : 3,
    fontScale,
  });
}

async function renderGrid(
  overrides: Partial<React.ComponentProps<typeof DashboardStatGrid>> = {},
) {
  return render(
    <DashboardStatGrid
      stats={STATS}
      loading={false}
      blocked={false}
      range="30d"
      {...overrides}
    />,
  );
}

describe("DashboardStatGrid responsive geometry", () => {
  it("keeps the existing two-column phone geometry", async () => {
    setWindow(390);
    await renderGrid();

    expect(
      StyleSheet.flatten(screen.getByLabelText(/^Subscribers,/).props.style),
    ).toEqual({ flexBasis: "48%", flexGrow: 1 });
  });

  it("uses three stable columns on a portrait iPad", async () => {
    setWindow(768);
    await renderGrid();

    expect(
      StyleSheet.flatten(screen.getByLabelText(/^Subscribers,/).props.style),
    ).toEqual({ flexBasis: "32%", flexGrow: 1 });
    expect(
      StyleSheet.flatten(
        screen.getByLabelText(/^Active sequences,/).props.style,
      ),
    ).toEqual({ flexBasis: "32%", flexGrow: 1 });
  });

  it("does not stretch an incomplete tablet row into oversized cards", async () => {
    setWindow(768);
    await renderGrid({ hidden: ["sequences"] });

    expect(
      StyleSheet.flatten(screen.getByLabelText(/^Sent 30d,/).props.style),
    ).toEqual({ flexBasis: "32%", flexGrow: 0 });
  });

  it("returns a 768pt tablet to two columns at the dense-text scale cap", async () => {
    setWindow(768, 1.4);
    await renderGrid();

    expect(
      StyleSheet.flatten(screen.getByLabelText(/^Subscribers,/).props.style),
    ).toEqual({ flexBasis: "48%", flexGrow: 1 });
  });

  it("matches the tablet loading skeleton to the three-column content grid", async () => {
    setWindow(768);
    await renderGrid({ loading: true });

    const skeletonGrid = screen.getByTestId("dashboard-stat-skeleton-grid");
    expect(skeletonGrid.children).toHaveLength(6);
    const firstCard = skeletonGrid.children[0];
    if (!firstCard || typeof firstCard === "string") {
      throw new Error("Expected the first skeleton card to be a native view");
    }
    expect(
      StyleSheet.flatten(firstCard.props.style),
    ).toMatchObject({ flexBasis: "32%", flexGrow: 1, gap: 10 });
  });

  it("fails closed to phone geometry for incomplete dimensions", () => {
    expect(dashboardStatGridColumns(undefined, undefined)).toBe(2);
    expect(dashboardStatGridColumns(Number.NaN, 1)).toBe(2);
    expect(dashboardStatGridColumns(699, 1)).toBe(2);
    expect(dashboardStatGridColumns(834, 3)).toBe(3);
  });
});
