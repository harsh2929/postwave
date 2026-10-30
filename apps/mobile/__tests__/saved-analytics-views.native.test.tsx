import { describe, expect, it, jest, afterEach } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React, { type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * Named window + breakdown presets at the top of the Analytics screen.
 *
 * The behaviour worth pinning is the round trip: what is SAVED must be exactly
 * what is APPLIED. A preset that mockStored the window but not the breakdown — or
 * that applied the current controls back to themselves — would look identical
 * on screen and quietly do nothing.
 */
let mockStored: Record<string, string> = { views: "[]" };
const mockSetPrefs = jest.fn((next: Record<string, string>) => {
  mockStored = { ...mockStored, ...next };
});

jest.mock("@/hooks/useListPreferences", () => ({
  useListPreferences: () => [mockStored, mockSetPrefs, { hydrated: true }],
}));

// eslint-disable-next-line import/first
import { ConfirmProvider } from "@/components/ConfirmSheet";
// eslint-disable-next-line import/first
import { ToastProvider } from "@/components/Toast";
// eslint-disable-next-line import/first
import { SavedAnalyticsViews } from "@/components/analytics/SavedAnalyticsViews";

const CURRENT = {
  range: "7d" as const,
  dimension: "campaign" as const,
  metric: "clicks" as const,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </SafeAreaProvider>
  );
}

afterEach(() => {
  mockStored = { views: "[]" };
  mockSetPrefs.mockClear();
});

describe("SavedAnalyticsViews", () => {
  it("explains itself before a preset exists", async () => {
    await render(
      <SavedAnalyticsViews current={CURRENT} onApply={jest.fn()} />,
      { wrapper },
    );
    expect(screen.getByText(/Save the window and breakdown/u)).toBeTruthy();
  });

  it("saves the window AND the breakdown under the typed name", async () => {
    await render(
      <SavedAnalyticsViews current={CURRENT} onApply={jest.fn()} />,
      { wrapper },
    );
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Save this view"));
    });
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("Name"), "Monday check");
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Save view"));
    });

    expect(mockSetPrefs).toHaveBeenCalledTimes(1);
    const written = JSON.parse(
      (mockSetPrefs.mock.calls[0]?.[0] as { views: string }).views,
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      name: "Monday check",
      range: "7d",
      dimension: "campaign",
      metric: "clicks",
    });
  });

  it("refuses an unnamed preset instead of storing a chip nobody can read", async () => {
    await render(
      <SavedAnalyticsViews current={CURRENT} onApply={jest.fn()} />,
      { wrapper },
    );
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Save this view"));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Save view"));
    });
    expect(mockSetPrefs).not.toHaveBeenCalled();
    expect(screen.getByText(/Give the view a name/u)).toBeTruthy();
  });

  it("applies every control the preset stored, not just the window", async () => {
    mockStored = {
      views: JSON.stringify([
        {
          id: "v1",
          name: "Deep dive",
          range: "90d",
          dimension: "domain",
          metric: "bounces",
        },
      ]),
    };
    const onApply = jest.fn();
    await render(<SavedAnalyticsViews current={CURRENT} onApply={onApply} />, {
      wrapper,
    });
    await act(async () => {
      fireEvent.press(screen.getByText("Deep dive"));
    });
    expect(onApply).toHaveBeenCalledWith({
      range: "90d",
      dimension: "domain",
      metric: "bounces",
    });
  });

  it("hides a preset whose stored vocabulary this build no longer has", async () => {
    mockStored = {
      views: JSON.stringify([
        {
          id: "v1",
          name: "Revenue view",
          range: "90d",
          dimension: "domain",
          metric: "revenue",
        },
      ]),
    };
    await render(
      <SavedAnalyticsViews current={CURRENT} onApply={jest.fn()} />,
      { wrapper },
    );
    expect(screen.queryByText("Revenue view")).toBeNull();
    expect(screen.getByText(/Save the window and breakdown/u)).toBeTruthy();
  });
});
