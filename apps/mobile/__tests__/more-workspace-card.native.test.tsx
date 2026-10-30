import { describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * The two support identifiers in More must be ordinary controls, not hidden
 * long-press knowledge. These tests pin the primary clipboard action, the
 * secondary Share path, assistive actions, and truthful clipboard feedback.
 */
const mockCopy = jest.fn(async (_value: string) => true);

jest.mock("@/lib/clipboard", () => ({
  copyToClipboard: (value: string) => mockCopy(value),
}));

// eslint-disable-next-line import/first
import { ToastProvider } from "@/components/Toast";
// eslint-disable-next-line import/first
import {
  MoreWorkspaceCard,
  type MoreWorkspaceCardProps,
} from "@/components/more/MoreWorkspaceCard";

const WORKSPACE_ID = "tenant_01J6YNE7ARJ8XB6PVZ9M2C4KTX";
const API_ORIGIN = "https://api.eu.postwave.example";

const BASE_PROPS: MoreWorkspaceCardProps = {
  workspaceLabel: "Acme Europe",
  tenantSubLabel: WORKSPACE_ID,
  connectionLabel: "Session",
  connectionSpoken: "Connected with a live session",
  connectionColor: "#22c55e",
  baseUrl: API_ORIGIN,
  email: "operator@acme.example",
  role: "admin",
  onShare: jest.fn(),
};

async function renderCard(overrides: Partial<MoreWorkspaceCardProps> = {}) {
  const onShare = jest.fn();
  const result = await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <MoreWorkspaceCard
          {...BASE_PROPS}
          {...overrides}
          onShare={onShare}
        />
      </ToastProvider>
    </SafeAreaProvider>,
  );
  return { onShare, result };
}

describe("MoreWorkspaceCard metadata controls", () => {
  it("copies the workspace ID on an ordinary press and confirms it", async () => {
    mockCopy.mockResolvedValue(true);
    const { onShare } = await renderCard();
    const control = screen.getByLabelText(`Copy workspace ID. ${WORKSPACE_ID}`);

    expect(control.props.accessibilityRole).toBe("button");
    expect(control.props.accessibilityHint).toMatch(/clipboard/u);
    expect(control.props.accessibilityActions).toEqual([
      { name: "copy", label: "Copy workspace ID" },
      { name: "share", label: "Share workspace ID" },
    ]);
    expect((control.props.style as { minHeight?: number }).minHeight).toBe(44);

    await act(async () => fireEvent.press(control));

    await waitFor(() => expect(mockCopy).toHaveBeenCalledWith(WORKSPACE_ID));
    expect(onShare).not.toHaveBeenCalled();
    expect(await screen.findByText("Workspace ID copied.")).toBeTruthy();
  });

  it("copies the API origin on an ordinary press", async () => {
    mockCopy.mockResolvedValue(true);
    await renderCard();

    await act(async () => {
      fireEvent.press(screen.getByLabelText(`Copy API origin. ${API_ORIGIN}`));
    });

    await waitFor(() => expect(mockCopy).toHaveBeenCalledWith(API_ORIGIN));
    expect(await screen.findByText("API origin copied.")).toBeTruthy();
  });

  it("publishes copy and share as explicit assistive actions", async () => {
    mockCopy.mockResolvedValue(true);
    const { onShare } = await renderCard();
    const control = screen.getByLabelText(`Copy API origin. ${API_ORIGIN}`);

    expect(control.props.accessibilityActions).toEqual([
      { name: "copy", label: "Copy API origin" },
      { name: "share", label: "Share API origin" },
    ]);

    await act(async () => {
      fireEvent(control, "accessibilityAction", {
        nativeEvent: { actionName: "copy" },
      });
    });
    await waitFor(() => expect(mockCopy).toHaveBeenCalledWith(API_ORIGIN));

    await act(async () => {
      fireEvent(control, "accessibilityAction", {
        nativeEvent: { actionName: "share" },
      });
    });
    expect(onShare).toHaveBeenCalledWith("API origin", API_ORIGIN);
  });

  it("reports a refused clipboard instead of claiming success", async () => {
    mockCopy.mockResolvedValue(false);
    await renderCard();

    await act(async () => {
      fireEvent.press(screen.getByLabelText(`Copy workspace ID. ${WORKSPACE_ID}`));
    });

    expect(
      await screen.findByText(
        "Couldn't copy the workspace ID. Long press to share it instead.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Workspace ID copied.")).toBeNull();
  });

  it("does not expose a copy action when there is no API origin", async () => {
    await renderCard({ baseUrl: null });
    const control = screen.getByLabelText("API origin not connected");

    expect(control.props.accessibilityState).toEqual({ disabled: true });
    expect(control.props.accessibilityActions).toBeUndefined();
    expect(control.props.accessibilityHint).toMatch(/no API origin/u);
    expect(screen.getByText("Not connected")).toBeTruthy();
  });
});
