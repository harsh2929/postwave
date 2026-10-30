/**
 * ReportContentSheet — what VoiceOver HEARS when a report lands or fails
 * (A11Y-3).
 *
 * The failure sentence is an assertive live region and the receipt a polite
 * one. Both are Android-only mechanisms: on iOS a newly mounted live region is
 * part of the reading order and nothing more (lib/a11y.ts), so a blind
 * reporter who pressed Send heard silence either way — no confirmation that a
 * report about a threat went through, and no word that it did not. jest-expo
 * renders as iOS, so `AccessibilityInfo.announceForAccessibility` is the
 * channel these cases listen on.
 *
 * Like report-content-sheet.native.test.tsx, only `../src/api/sdkClient` is
 * mocked, so the real submit chain produces every sentence below.
 *
 * LANDING ORDER: the sheet's nullable `reference` (ReportSubmitState, the
 * receipt parse in src/api/contentReports.ts) belongs to the content-report
 * bundle. The spoken receipt is keyed on a truthy reference, so the third case
 * holds with or without that parse, but the ReportSentView hunk that makes it
 * speak sits inside that bundle's signature change and should land with it.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AccessibilityInfo } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  ReportContentSheet,
  type ReportTarget,
} from "../src/components/ReportContentSheet";

const mockRequest = jest.fn<(...args: unknown[]) => Promise<unknown>>();

// src/api/request.ts reaches the client through `./sdkClient`, which the
// routes mapper never sees; mocking the resolved module covers every importer.
jest.mock("../src/api/sdkClient", () => ({
  getClient: () => ({ client: { request: mockRequest } }),
}));

const TARGET: ReportTarget = {
  kind: "ai_output",
  ref: "msg-42",
  label: "Here is a welcome email…",
};
const TYPED = "The reply told me to harass a named person at work.";
const RETRY_COPY =
  "We couldn't send that just now. Try again — your report is still here.";

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

const listen = () => jest.spyOn(AccessibilityInfo, "announceForAccessibility");
let spoken: ReturnType<typeof listen>;

beforeEach(() => {
  mockRequest.mockReset();
  spoken = listen();
});

afterEach(() => {
  spoken.mockRestore();
});

async function sendReport() {
  await render(<ReportContentSheet target={TARGET} onClose={jest.fn()} />, {
    wrapper,
  });
  await fireEvent.changeText(screen.getByLabelText("Tell us more"), TYPED);
  // Vacuity floor: nothing about the outcome is said before Send is pressed.
  expect(spoken).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText("Send report"));
}

describe("the outcome of Send is spoken on iOS", () => {
  it("a dropped connection speaks the retry sentence the screen shows", async () => {
    mockRequest.mockRejectedValueOnce(new TypeError("Network request failed"));
    await sendReport();

    expect(await screen.findByText(RETRY_COPY)).toBeTruthy();
    expect(spoken).toHaveBeenCalledWith(RETRY_COPY);
  });

  it("a 201 speaks the receipt, reference included", async () => {
    mockRequest.mockResolvedValueOnce({
      reference: "PWR-7Q2K",
      received_at: "2026-09-14T10:00:00Z",
    });
    await sendReport();

    expect(await screen.findByText("Report sent")).toBeTruthy();
    const said = spoken.mock.calls.map(([text]) => text);
    expect(said).toContainEqual(
      expect.stringMatching(/^Report sent\. Reference PWR-7Q2K\./u),
    );
  });

  it("a 2xx without a reference speaks the receipt without an empty one", async () => {
    mockRequest.mockResolvedValueOnce({ data: { reference: "PWR-7Q2K" } });
    await sendReport();

    expect(await screen.findByText("Report sent")).toBeTruthy();
    const said = spoken.mock.calls.map(([text]) => text);
    expect(said).toContainEqual(expect.stringMatching(/^Report sent\./u));
    expect(said.some((text) => /Reference/u.test(text))).toBe(false);
  });
});
