import { describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * DELIVERABILITY#20 — the control labelled "Copy" must copy.
 *
 * On the one screen whose entire job is transporting a DKIM value into a
 * registrar form, "Copy" opened the SHARE sheet and swallowed every error. The
 * regression this file exists to prevent is not cosmetic: a share sheet offers
 * no paste target in most registrar apps, and the value is 400 characters, so
 * a broken Copy leaves the record genuinely unobtainable from a phone.
 *
 * It pins four things:
 *   - Copy writes to the CLIPBOARD, not the share sheet;
 *   - host and value are separate controls, because a registrar form has two
 *     boxes and one blob fits neither;
 *   - a clipboard that refuses is REPORTED, not swallowed — `setStringAsync`
 *     resolves false on a locked pasteboard;
 *   - Share still exists and still carries the whole record.
 */
const mockCopy = jest.fn(async (_value: string) => true);

jest.mock("@/lib/clipboard", () => ({
  copyToClipboard: (value: string) => mockCopy(value),
}));

// eslint-disable-next-line import/first
import { DnsRecordCard } from "@/components/deliverability/DnsRecordCard";
// eslint-disable-next-line import/first
import { ToastProvider } from "@/components/Toast";

const DKIM_VALUE = `v=DKIM1; k=rsa; p=${"M".repeat(392)}`;

const RECORD = {
  type: "TXT",
  name: "pw1._domainkey.mail.example.com",
  value: DKIM_VALUE,
};

async function renderCard(onShare = jest.fn()) {
  const view = await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <DnsRecordCard
          record={RECORD}
          domain="mail.example.com"
          onShare={onShare}
        />
      </ToastProvider>
    </SafeAreaProvider>,
  );
  return { view, onShare };
}

describe("DnsRecordCard", () => {
  it("copies the record VALUE to the clipboard, not to a share sheet", async () => {
    mockCopy.mockClear();
    const { onShare } = await renderCard();

    await act(async () => {
      fireEvent.press(
        screen.getByLabelText("Copy the TXT record value for mail.example.com"),
      );
    });

    expect(mockCopy).toHaveBeenCalledWith(DKIM_VALUE);
    expect(onShare).not.toHaveBeenCalled();
    expect(await screen.findByText("TXT value copied")).toBeTruthy();
  });

  it("copies the host separately, because a registrar form has two boxes", async () => {
    mockCopy.mockClear();
    await renderCard();

    await act(async () => {
      fireEvent.press(
        screen.getByLabelText("Copy the TXT host for mail.example.com"),
      );
    });

    expect(mockCopy).toHaveBeenCalledWith("pw1._domainkey.mail.example.com");
    expect(await screen.findByText("TXT host copied")).toBeTruthy();
  });

  it("reports a clipboard that refused instead of claiming a copy", async () => {
    mockCopy.mockClear();
    mockCopy.mockImplementationOnce(async () => false);
    await renderCard();

    await act(async () => {
      fireEvent.press(
        screen.getByLabelText("Copy the TXT record value for mail.example.com"),
      );
    });

    expect(
      await screen.findByText(/Couldn't reach the clipboard/),
    ).toBeTruthy();
    expect(screen.queryByText("TXT value copied")).toBeNull();
  });

  it("keeps Share for the whole record and labels it honestly", async () => {
    mockCopy.mockClear();
    const { onShare } = await renderCard();

    await act(async () => {
      fireEvent.press(
        screen.getByLabelText("Share the whole TXT record for mail.example.com"),
      );
    });

    expect(onShare).toHaveBeenCalledWith(RECORD);
    expect(mockCopy).not.toHaveBeenCalled();
  });

  it("carries the complete value in the accessibility tree even while clamped", async () => {
    await renderCard();
    // The visual clamp is three lines; a screen reader must still get all 400+.
    expect(
      screen.getByLabelText(
        `TXT record value for mail.example.com: ${DKIM_VALUE}`,
      ),
    ).toBeTruthy();
  });
});
