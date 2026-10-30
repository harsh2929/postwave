/**
 * SMS export — reason-gated CSV export to the system share sheet.
 *
 * Claims pinned:
 *  1. The reason gate is enforced IN PLACE before any request.
 *  2. A successful export hands the CSV TEXT to Share.share and renders the
 *     server-bounds receipt (including the truncation warning verbatim).
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import React from "react";
import { Share } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockExport = jest.fn<
  (input: { reason: string }) => Promise<{
    csv: string;
    truth: {
      limit: number;
      asOf: string;
      rowCount: number;
      truncated: boolean;
    };
    filename: string;
  }>
>();
jest.mock("@/api/smsConversationsExport", () => ({
  exportSmsConversationsCsv: (input: { reason: string }) => mockExport(input),
}));

// eslint-disable-next-line import/first -- must follow the api mock.
import { SmsExportSheet } from "@/components/sms/SmsExportSheet";

const ACCESS = {
  identity: { fingerprint: "identity-1", tenantId: "t", userId: "u" },
  roleAllowed: true,
  canRequest: true,
  online: true,
  sessionReady: true,
  denialReason: null,
} as never;

afterEach(() => {
  mockExport.mockReset();
});

async function renderSheet() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <SmsExportSheet visible access={ACCESS} onClose={jest.fn()} />
    </SafeAreaProvider>,
  );
}

describe("sms export sheet", () => {
  it("refuses an empty reason in place, before any request", async () => {
    await renderSheet();
    await fireEvent.press(
      screen.getByLabelText("Run the audited export and open the share sheet"),
    );
    expect(
      screen.getByText(/An audit reason is required/u),
    ).toBeTruthy();
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("shares the CSV text and shows the truncation receipt verbatim", async () => {
    const shareSpy = jest
      .spyOn(Share, "share")
      .mockResolvedValue({ action: "sharedAction" } as never);
    mockExport.mockResolvedValue({
      csv: "phone_e164,last_message_at\n+15552345678,2026-08-21T09:00:00Z\n",
      truth: {
        limit: 10_000,
        asOf: "2026-08-21T10:00:00Z",
        rowCount: 10_000,
        truncated: true,
      },
      filename: "postwave-sms-conversations-x.csv",
    });
    await renderSheet();
    await fireEvent.changeText(
      screen.getByLabelText("Audit reason for the export"),
      "quarterly compliance review",
    );
    await fireEvent.press(
      screen.getByLabelText("Run the audited export and open the share sheet"),
    );
    await waitFor(() =>
      expect(screen.getByText(/TRUNCATED at the 10000-row server cap/u)).toBeTruthy(),
    );
    expect(mockExport.mock.calls[0]?.[0]).toEqual({
      reason: "quarterly compliance review",
    });
    expect(shareSpy.mock.calls[0]?.[0]).toEqual({
      message:
        "phone_e164,last_message_at\n+15552345678,2026-08-21T09:00:00Z\n",
      title: "postwave-sms-conversations-x.csv",
    });
    shareSpy.mockRestore();
  });
});
