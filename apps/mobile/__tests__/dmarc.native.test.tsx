import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { Share } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * The DMARC screen carried 500 lines and zero rendering tests. These pin the
 * three things that make a claim:
 *
 *   - the WINDOW is named. The old header summed pass/fail across "the newest
 *     50 rows" with no denominator, so the same number meant something
 *     different per tenant. The summary must say which window it describes.
 *   - the insights half renders its own honest unavailable reason instead of
 *     an empty card, because there is no single-domain selection.
 *   - the export shares the FILTERED set, not the whole window — exporting
 *     something other than what is on screen is the classic export bug.
 */
const mockReports: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
  refetch: jest.fn(async () => undefined),
};

const mockInsights: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
  refetch: jest.fn(async () => undefined),
};

jest.mock("@/hooks/useDmarcOps", () => {
  const ranges = [
    { value: "7d", label: "7 days", days: 7 },
    { value: "30d", label: "30 days", days: 30 },
    { value: "90d", label: "90 days", days: 90 },
  ];
  return {
    DMARC_RANGES: ranges,
    dmarcRangeDays: () => 30,
    dmarcRangeStart: () => "2026-06-25T00:00:00.000Z",
    useDmarcReports: () => mockReports,
    useDmarcInsights: () => mockInsights,
  };
});

// eslint-disable-next-line import/first
import Dmarc from "../app/(tabs)/dmarc";

function report(over: Record<string, unknown> = {}) {
  return {
    id: "report-1",
    domain: "mail.example.com",
    orgName: "google.com",
    passCount: 120,
    failCount: 0,
    dateBegin: "2026-07-01T00:00:00Z",
    dateEnd: "2026-07-02T00:00:00Z",
    receivedAt: "2026-07-02T06:11:00Z",
    policyP: "quarantine",
    // A STRING, as `parseDmarcReports` coerces it — a numeric fixture here
    // would pass a shape the hook never returns and hide `policyLabel`'s
    // `.trim()` crash.
    policyPct: "100",
    ...over,
  };
}

async function renderScreen() {
  return await render(React.createElement(Dmarc), {
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

function reset() {
  mockReports.data = undefined;
  mockReports.isLoading = false;
  mockReports.isError = false;
  mockInsights.data = undefined;
  mockInsights.isLoading = false;
  mockInsights.isError = false;
}

describe("dmarc screen", () => {
  it("names the window in the summary rather than a bare row count", async () => {
    reset();
    mockReports.data = {
      value: [report(), report({ id: "r2", failCount: 9, passCount: 40 })],
      fromSnapshot: false,
      capturedAt: null,
    };

    const screen = await renderScreen();
    expect(
      screen.getByText(
        /2 reports in the last 30 days · 160 passing · 9 failing/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Raw reports")).toBeTruthy();
  });

  it("explains why insights are missing instead of showing an empty card", async () => {
    reset();
    // Two domains and no selection: the insights read is per-domain
    // server-side, so there is genuinely nothing to show — and the card must
    // say WHY rather than rendering a blank panel.
    mockReports.data = {
      value: [report(), report({ id: "r2", domain: "other.example.com" })],
      fromSnapshot: false,
      capturedAt: null,
    };

    const screen = await renderScreen();
    expect(screen.getByText("Alignment insights unavailable")).toBeTruthy();
    expect(
      screen.getByText(/Pick a single domain to see its alignment trend/),
    ).toBeTruthy();
  });

  it("offers the export as a labelled ≥44pt button naming the row count", async () => {
    reset();
    mockReports.data = {
      value: [report(), report({ id: "r2" })],
      fromSnapshot: false,
      capturedAt: null,
    };

    const screen = await renderScreen();
    const action = screen.getByLabelText("Share these 2 reports as CSV");
    expect(action.props.accessibilityRole).toBe("button");
    const style = Array.isArray(action.props.style)
      ? Object.assign({}, ...action.props.style)
      : action.props.style;
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
  });

  it("exports the FILTERED set, quoted, not the whole window", async () => {
    reset();
    mockReports.data = {
      value: [
        report({ orgName: "Yahoo!, Inc." }),
        report({ id: "r2", failCount: 4, passCount: 10 }),
      ],
      fromSnapshot: false,
      capturedAt: null,
    };
    const share = jest
      .spyOn(Share, "share")
      .mockResolvedValue({ action: "sharedAction" } as never);

    const screen = await renderScreen();
    // Narrow to reports WITH failures: one of the two rows. The header's
    // label must follow the filtered count, not the window's.
    await fireEvent.press(screen.getByLabelText("With failures"));
    await fireEvent.press(screen.getByLabelText("Share this report as CSV"));

    expect(share).toHaveBeenCalledTimes(1);
    const payload = share.mock.calls[0]?.[0] as {
      message: string;
      title: string;
    };
    expect(payload.title).toContain("last 30 days");
    // The RFC4180 quoting survives the round trip into the share sheet.
    expect(payload.message.split("\n")[0]).toBe(
      "domain,reporter,pass,fail,period_start,period_end,received_at,policy,report_id",
    );
    // Exactly the ONE failing row, not the two in the window.
    expect(payload.message.split("\n")).toHaveLength(2);
    expect(payload.message).not.toContain("Yahoo!");
    share.mockRestore();
  });

  it("says OFFLINE rather than 'no DMARC reports' when it could not read", async () => {
    reset();
    mockReports.data = undefined;

    const screen = await renderScreen();
    // Nothing on this rung may assert that the tenant has no reports.
    expect(screen.queryByText("No DMARC reports")).toBeTruthy();
    expect(screen.queryByLabelText(/Share .* as CSV/)).toBeNull();
  });
});
