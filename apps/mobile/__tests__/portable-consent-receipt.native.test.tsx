import { describe, expect, it, jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * AUDIENCE#30 — the per-profile half of a DSAR.
 *
 * The profile already showed OUR consent ledger. What it could not do was hand
 * the SUBJECT the document they are owed: the ISO 27560 / Kantara CR v1.1
 * receipt at GET /api/v1/subscribers/{id}/consent-receipt.json.
 *
 * Four things must hold, and each of them is a way the card could lie:
 *   - the export route is ScopeAdmin, so for anyone else the card is ABSENT,
 *     not a permanently-403 button;
 *   - it does not fetch until asked — the response is a full PII export;
 *   - "Copy" copies the WHOLE document, and a refused clipboard is reported
 *     rather than claimed as a success;
 *   - a parsed-null receipt says so instead of rendering an empty compliance
 *     document.
 */
const mockCopy = jest.fn(async (_value: string) => true);
const mockReceipt = jest.fn(
  (_subscriberId: string | undefined, _open: boolean) =>
    ({}) as Record<string, unknown>,
);

jest.mock("@/lib/clipboard", () => ({
  copyToClipboard: (value: string) => mockCopy(value),
}));

jest.mock("@/hooks/useSubscriberRecordHistory", () => ({
  usePortableConsentReceipt: (subscriberId: string, open: boolean) =>
    mockReceipt(subscriberId, open),
}));

// eslint-disable-next-line import/first
import { PortableReceiptCard } from "@/components/subscriber/sections/PortableReceiptCard";
// eslint-disable-next-line import/first
import { ToastProvider } from "@/components/Toast";

const RECEIPT = {
  version: "KI-CR-v1.1",
  jurisdiction: "ISO/IEC 27560",
  receiptId: "prof_123",
  generatedAt: "2026-07-25T10:00:00Z",
  subjectEmail: "ada@example.com",
  subjectProfileId: "prof_123",
  controllerName: "Acme Ltd",
  controllerContact: "dpo@acme.test",
  policyUri: "https://acme.test/privacy",
  purposes: [
    {
      purpose: "email_marketing",
      label: "Email marketing",
      consentType: "EXPLICIT",
      active: true,
      grantedAt: "2026-01-04T09:00:00Z",
    },
    {
      purpose: "sms_marketing",
      label: "SMS marketing",
      consentType: "EXPLICIT",
      active: false,
      grantedAt: "",
    },
  ],
  historyCount: 2,
};

function queryResult(over: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
    isSuccess: false,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

async function renderCard(canReadConsent = true) {
  return await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <PortableReceiptCard
          subscriberId="sub-9"
          canReadConsent={canReadConsent}
        />
      </ToastProvider>
    </SafeAreaProvider>,
  );
}

describe("portable consent receipt card", () => {
  it("is mounted by subscriber detail with the route's id and consent gate", () => {
    const detailSections = readFileSync(
      join(
        process.cwd(),
        "src/components/subscriber/SubscriberDetailSections.tsx",
      ),
      "utf8",
    );

    expect(detailSections).toContain(
      'import { PortableReceiptCard } from "@/components/subscriber/sections/PortableReceiptCard";',
    );
    expect(detailSections).toMatch(
      /<PortableReceiptCard\s+subscriberId=\{subscriberId\}\s+canReadConsent=\{canReadConsent\}\s*\/>/u,
    );
  });

  it("is absent entirely for a session that cannot call the admin route", async () => {
    mockReceipt.mockReturnValue(queryResult());
    await renderCard(false);
    expect(screen.queryByLabelText("Portable consent receipt")).toBeNull();
  });

  it("does not fetch until the operator asks for the document", async () => {
    mockReceipt.mockReturnValue(queryResult());
    await renderCard();
    // Rendered, but `open` is false — the hook's `enabled` depends on it.
    expect(screen.getByLabelText("Portable consent receipt")).toBeTruthy();
    expect(mockReceipt).toHaveBeenLastCalledWith("sub-9", false);
  });

  it("renders granted state as a WORD, never colour alone", async () => {
    mockReceipt.mockReturnValue(queryResult({ data: RECEIPT }));
    await renderCard();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Portable consent receipt"));
    });

    expect(
      screen.getByText(
        "1 of 2 purposes currently granted, 2 recorded changes.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Not granted")).toBeTruthy();
    expect(screen.getByLabelText(/^SMS marketing: not granted/)).toBeTruthy();
  });

  it("copies the WHOLE document, not a summary of it", async () => {
    mockCopy.mockClear();
    mockCopy.mockResolvedValue(true);
    mockReceipt.mockReturnValue(queryResult({ data: RECEIPT }));
    await renderCard();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Portable consent receipt"));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Copy the full consent receipt"));
    });

    await waitFor(() => expect(mockCopy).toHaveBeenCalledTimes(1));
    const copied = JSON.parse(String(mockCopy.mock.calls[0]?.[0]));
    expect(copied.version).toBe("KI-CR-v1.1");
    expect(copied.purposes).toHaveLength(2);
    expect(copied.historyCount).toBe(2);
    await waitFor(() =>
      expect(
        screen.getByText(
          "Receipt copied. Save it as subscriber-sub-9-consent-receipt-2026-07-25.json.",
        ),
      ).toBeTruthy(),
    );
  });

  it("reports a refused clipboard rather than claiming success", async () => {
    mockCopy.mockClear();
    mockCopy.mockResolvedValue(false);
    mockReceipt.mockReturnValue(queryResult({ data: RECEIPT }));
    await renderCard();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Portable consent receipt"));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Copy the full consent receipt"));
    });

    await waitFor(() =>
      expect(
        screen.getByText(
          "The clipboard refused the copy. Try again, or use the web admin.",
        ),
      ).toBeTruthy(),
    );
  });

  it("says a null receipt is unusable instead of rendering a blank document", async () => {
    mockReceipt.mockReturnValue(queryResult({ data: null, isSuccess: true }));
    await renderCard();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Portable consent receipt"));
    });
    expect(
      screen.getByText(/The server returned no usable receipt/),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Copy the full consent receipt")).toBeNull();
  });
});
