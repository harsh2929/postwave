/**
 * The tap-to-text sheet at the rendered seam.
 *
 * The vitest suite proves the generator's rules; what it cannot prove is that
 * the SHEET only ever shows a whole artifact. The risk here is a half-rendered
 * block: a QR or a copy button that is live while the destination is still
 * being typed hands the operator a dead `sms:` link they then paste into a
 * campaign. So these tests pin three things:
 *
 *   - nothing generative renders until a real block exists;
 *   - what renders is the SAME string the generator produced (link, embed
 *     HTML, QR payload), not a re-derivation;
 *   - Copy link copies the LINK — the two copy buttons carry different
 *     payloads and swapping them is invisible without an assertion.
 *
 * The consent boundary sentence is asserted verbatim: it is the sheet's whole
 * defence against reading as a provider/consent action.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { Share } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

jest.mock("react-native-qrcode-svg", () => {
  const ReactModule = require("react");
  const { Text } = require("react-native");
  return {
    __esModule: true,
    default: ({ value }: { value: string }) =>
      ReactModule.createElement(Text, null, `QR:${value}`),
  };
});

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => true),
}));

import { TapToTextSheet } from "../src/components/growth/TapToTextSheet";

const Clipboard = require("expo-clipboard") as {
  setStringAsync: jest.Mock<(text: string) => Promise<boolean>>;
};

async function renderSheet() {
  return render(<TapToTextSheet visible onClose={() => undefined} />, {
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

async function fillValidBlock(screen: Awaited<ReturnType<typeof renderSheet>>) {
  await fireEvent.changeText(
    screen.getByLabelText("Short code or number"),
    "12345",
  );
  await fireEvent.changeText(
    screen.getByLabelText("Keyword sent as the message body"),
    "JOIN",
  );
}

describe("TapToTextSheet", () => {
  it("states the local-tool boundary before anything is generated", async () => {
    const screen = await renderSheet();
    expect(
      screen.getByText(
        "Local creative tool only. Generating, copying, or scanning this asset does not configure a messaging provider, enroll a person, transmit an inbound callback to Moosewave, or record or prove consent.",
      ),
    ).toBeTruthy();
  });

  it("generates nothing at all until a whole block exists", async () => {
    const screen = await renderSheet();
    expect(screen.queryByText("Generated SMS link")).toBeNull();
    expect(screen.queryByText("Copy link")).toBeNull();
    expect(
      screen.getByText(
        "Enter a valid destination and keyword to generate the link, the embed HTML, and a QR.",
      ),
    ).toBeTruthy();

    // A destination alone is not a block: the keyword is the message body.
    await fireEvent.changeText(
      screen.getByLabelText("Short code or number"),
      "12345",
    );
    expect(screen.queryByText("Generated SMS link")).toBeNull();
  });

  it("renders the link, the embed HTML and the QR payload once it does", async () => {
    const screen = await renderSheet();
    await fillValidBlock(screen);

    expect(screen.getByText("sms:12345?body=JOIN")).toBeTruthy();
    expect(
      screen.getByText(
        '<a href="sms:12345?body=JOIN" style="display:inline-block;padding:10px 18px;background:#0e8169;color:#fff;border-radius:6px;font-weight:600;text-decoration:none;font-family:sans-serif;">Text JOIN to 12345</a>',
      ),
    ).toBeTruthy();
    // The QR encodes the link itself, not the label or the HTML.
    expect(screen.getByText("QR:sms:12345?body=JOIN")).toBeTruthy();
  });

  it("names the destination rule instead of silently generating nothing", async () => {
    const screen = await renderSheet();
    await fireEvent.changeText(
      screen.getByLabelText("Short code or number"),
      "1234",
    );
    expect(
      screen.getByText(
        "Enter an unambiguous 5–6 digit short code or plus-prefixed E.164 number. Letters, controls, bidi marks, and unsigned long numbers are rejected.",
      ),
    ).toBeTruthy();
  });

  it("copies the LINK from Copy link and the ANCHOR from Copy HTML", async () => {
    const screen = await renderSheet();
    await fillValidBlock(screen);

    await fireEvent.press(screen.getByLabelText("Copy link"));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("sms:12345?body=JOIN");

    await fireEvent.press(screen.getByLabelText("Copy HTML"));
    const copied = Clipboard.setStringAsync.mock.calls.map((call) => call[0]);
    expect(copied.some((text) => text.startsWith("<a href="))).toBe(true);
  });

  it("shares a self-describing message, not a bare sms: string", async () => {
    // The share sheet is the phone's whole advantage over desktop's copy
    // button: the link goes to a designer in one gesture. A bare `sms:` URI
    // dropped into a chat is unreadable, so the label rides along.
    const share = jest
      .spyOn(Share, "share")
      .mockResolvedValue({ action: "sharedAction" } as never);
    const screen = await renderSheet();
    await fillValidBlock(screen);

    await fireEvent.press(screen.getByLabelText("Share link"));
    expect(share).toHaveBeenCalledWith({
      message: "Text JOIN to 12345\nsms:12345?body=JOIN",
    });
    share.mockRestore();
  });

  it("SHOUTS the keyword but leaves the creative's own label alone", async () => {
    // The keyword IS a shouted token (JOIN), so its keyboard is caps-locked.
    // The button label is a sentence a reader will see on the finished
    // creative, and a caps-locked keyboard silently ships "JOIN OUR LIST".
    const screen = await renderSheet();
    expect(
      screen.getByLabelText("Keyword sent as the message body").props
        .autoCapitalize,
    ).toBe("characters");
    expect(
      screen.getByLabelText("Button label shown in the creative").props
        .autoCapitalize,
    ).toBe("sentences");
  });
});
