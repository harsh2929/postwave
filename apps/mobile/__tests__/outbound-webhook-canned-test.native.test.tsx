import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

jest.mock("@/api/settings", () => {
  const testWebhook = jest.fn(async () => ({
    data: { status_code: 202, signed: true },
    error: null,
  }));
  return {
    __esModule: true,
    __testWebhook: testWebhook,
    createOutboundWebhook: jest.fn(),
    deleteOutboundWebhook: jest.fn(),
    testOutboundWebhook: testWebhook,
  };
});

jest.mock("@/hooks/useOutboundWebhooks", () => ({
  useOutboundWebhooks: () => ({
    data: [
      {
        id: "018f3f6a-5c6d-7a8b-9c0d-1e2f3a4b5c6d",
        url: "https://hooks.example.com/postwave",
        description: "Primary handler",
        events: ["subscriber.added"],
        active: true,
        created_at: "2026-08-30T00:00:00Z",
        consecutive_failures: 0,
      },
    ],
    error: null,
    isError: false,
    isLoading: false,
  }),
}));

jest.mock("@/hooks/useOutboundKeyRotation", () => ({
  useOutboundKeyRotation: () => ({
    rotatingId: null,
    rotate: jest.fn(async () => undefined),
  }),
}));

// Jest hoists the factories above this import; keeping it below makes the
// harness exports available before the component module is evaluated.
// eslint-disable-next-line import/first
import { OutboundWebhooksSection } from "@/components/settings/OutboundWebhooksSection";

const settingsHarness = jest.requireMock("@/api/settings") as {
  __testWebhook: jest.Mock<(id: string) => Promise<unknown>>;
};

afterEach(() => {
  settingsHarness.__testWebhook.mockClear();
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

describe("the outbound webhook canned test", () => {
  it("wires the Settings Test control to the selected endpoint", async () => {
    await render(<OutboundWebhooksSection />, { wrapper });

    await fireEvent.press(
      await screen.findByLabelText("Send a test event to Primary handler"),
    );

    await waitFor(() =>
      expect(settingsHarness.__testWebhook).toHaveBeenCalledWith(
        "018f3f6a-5c6d-7a8b-9c0d-1e2f3a4b5c6d",
      ),
    );
  });
});
