/**
 * WebhookSecretCard — the four controls on the app's only shown-once value.
 *
 * This card READS as covered: inbound-endpoint-admin.native.test.tsx renders it
 * and asserts the "Shown once; save it before dismissing" warning. But the
 * control-coverage audit found that none of its four controls — Copy, Share,
 * the "I've saved this" tick, and Done — had ever been pressed. Every risk on
 * this card lives in what happens AFTER a press:
 *
 *  1. COPY IS THE PRIMARY CAPTURE, AND ONLY A LANDED WRITE COUNTS. A clipboard
 *     call that resolves false (or throws) must not unlock the irreversible
 *     Done button on a secret the operator never actually received. The card
 *     goes through `lib/secretClipboard`, so a successful copy also arms the
 *     90-second conditional clear — the promise the card's own copy makes.
 *  2. SHARE COUNTS ONLY IF SOMETHING WAS SHARED. A dismissed share sheet is
 *     not a capture.
 *  3. DONE IS IRREVERSIBLE AND MUST STAY GATED. The server will not produce
 *     this value again; dismissing it early is unrecoverable on mobile, which
 *     has no rotate. So the gate is asserted from BOTH sides: the accessible
 *     name says why it is unavailable, and pressing it while gated does
 *     nothing at all.
 *  4. DONE ACTUALLY DESTROYS THE PROCESS STASH. Not a state flag — the shared
 *     `revealOnceSecret` module, read back here.
 *
 * `expo-clipboard` is mocked (it is the native boundary); `lib/secretClipboard`
 * and `lib/revealOnceSecret` run for real, because their behaviour is the
 * behaviour under test.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Share } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { ReactNode } from "react";

import { ToastProvider } from "@/components/Toast";
import { WebhookSecretCard } from "@/components/settings/WebhookSecretCard";
import { SECRET_CLIPBOARD_TTL_MS } from "@/lib/secretClipboard";
import { clearSecret, peekSecret, stashSecret } from "@/lib/revealOnceSecret";

/** The native clipboard, and only it. */
const mockClipboard: {
  written: string[];
  writeResult: boolean;
  writeThrows: boolean;
  readValue: string;
} = {
  written: [],
  writeResult: true,
  writeThrows: false,
  readValue: "",
};

jest.mock("expo-clipboard", () => ({
  setStringAsync: async (value: string) => {
    if (mockClipboard.writeThrows) throw new Error("pasteboard unavailable");
    mockClipboard.written.push(value);
    mockClipboard.readValue = value;
    return mockClipboard.writeResult;
  },
  getStringAsync: async () => mockClipboard.readValue,
}));

const ENDPOINT_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "whsec_live_9f2c4b8a1d6e";

const DONE_GATED = "Dismiss is unavailable until you confirm you have saved the secret";
const DONE_READY = "Dismiss the signing secret";
const COPY = "Copy the signing secret to the clipboard";
const SHARE = "Share the signing secret to a password manager or another app";
const TICK = "I've saved this secret";

const onDismiss = jest.fn();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>{children}</ToastProvider>
    </SafeAreaProvider>
  );
}

async function renderCard() {
  await render(
    <WebhookSecretCard
      revision={1}
      onDismiss={onDismiss}
      expectedId={ENDPOINT_ID}
    />,
    { wrapper },
  );
}

async function press(element: Parameters<typeof fireEvent.press>[0]) {
  await act(async () => {
    fireEvent.press(element);
  });
}

beforeEach(() => {
  // Fake timers for the WHOLE file, not just the two expiry tests. A landed
  // copy arms a 90-second clear that deliberately outlives the component
  // (`cancelClipboardExpiry` is never cancelled on unmount, so closing the
  // sheet cannot strand the secret on the pasteboard) — under real timers that
  // leaves a live handle per test and jest never exits.
  jest.useFakeTimers();
  mockClipboard.written = [];
  mockClipboard.writeResult = true;
  mockClipboard.writeThrows = false;
  mockClipboard.readValue = "";
  onDismiss.mockClear();
  jest
    .spyOn(Share, "share")
    .mockImplementation(async () => ({ action: Share.sharedAction }));
  stashSecret(ENDPOINT_ID, SECRET);
});

afterEach(() => {
  jest.useRealTimers();
  clearSecret();
});

describe("WebhookSecretCard — Copy", () => {
  it("writes the STASHED secret to the clipboard and names the clear window", async () => {
    await renderCard();

    await press(screen.getByLabelText(COPY));

    // The value, not the title or the placeholder: this is the one string the
    // server will never produce again.
    expect(mockClipboard.written).toEqual([SECRET]);
    expect(
      screen.getByText("Secret copied. It clears from the clipboard in 90s."),
    ).toBeTruthy();
  });

  it("a successful copy is the capture that unlocks Done", async () => {
    await renderCard();

    expect(screen.getByLabelText(DONE_GATED)).toBeTruthy();
    await press(screen.getByLabelText(COPY));

    expect(screen.getByLabelText(DONE_READY)).toBeTruthy();
    expect(screen.queryByLabelText(DONE_GATED)).toBeNull();
  });

  it("a clipboard write that does NOT land is not a capture", async () => {
    mockClipboard.writeResult = false;
    await renderCard();

    await press(screen.getByLabelText(COPY));

    expect(
      screen.getByText(
        /Couldn't reach the clipboard\. Use “Save to another app”/u,
      ),
    ).toBeTruthy();
    // The whole point: Done stays shut on a secret the operator never got.
    expect(screen.getByLabelText(DONE_GATED)).toBeTruthy();
    await press(screen.getByLabelText(DONE_GATED));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(peekSecret()?.value).toBe(SECRET);
  });

  it("a clipboard that throws is not a capture either", async () => {
    mockClipboard.writeThrows = true;
    await renderCard();

    await press(screen.getByLabelText(COPY));

    expect(mockClipboard.written).toEqual([]);
    expect(screen.getByLabelText(DONE_GATED)).toBeTruthy();
  });

  it("the copy self-clears after 90 seconds, and only if the clipboard still holds it", async () => {
    await renderCard();
    await press(screen.getByLabelText(COPY));
    expect(mockClipboard.written).toEqual([SECRET]);

    await act(async () => {
      jest.advanceTimersByTime(SECRET_CLIPBOARD_TTL_MS);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The card promises the secret is "never saved to the device"; leaving it
    // on a Universal-Clipboard-synced pasteboard would break that quietly.
    expect(mockClipboard.written).toEqual([SECRET, ""]);
    expect(mockClipboard.readValue).toBe("");
  });

  it("leaves a clipboard the operator has overwritten alone", async () => {
    await renderCard();
    await press(screen.getByLabelText(COPY));
    // The operator copied something else in the meantime. That copy is theirs;
    // eating it would be a worse bug than the one the timer fixes.
    mockClipboard.readValue = "an unrelated thing the operator copied";

    await act(async () => {
      jest.advanceTimersByTime(SECRET_CLIPBOARD_TTL_MS);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockClipboard.written).toEqual([SECRET]);
    expect(mockClipboard.readValue).toBe(
      "an unrelated thing the operator copied",
    );
  });
});

describe("WebhookSecretCard — Share", () => {
  it("hands the secret to the share sheet under a title that names it", async () => {
    await renderCard();

    await press(screen.getByLabelText(SHARE));

    expect(Share.share).toHaveBeenCalledWith({
      message: SECRET,
      title: "Moosewave webhook signing secret",
    });
    expect(screen.getByLabelText(DONE_READY)).toBeTruthy();
  });

  it("a DISMISSED share sheet is not a capture", async () => {
    jest
      .spyOn(Share, "share")
      .mockImplementation(async () => ({ action: Share.dismissedAction }));
    await renderCard();

    await press(screen.getByLabelText(SHARE));

    expect(Share.share).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(DONE_GATED)).toBeTruthy();
    await press(screen.getByLabelText(DONE_GATED));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("says so when the share sheet cannot open, and captures nothing", async () => {
    jest.spyOn(Share, "share").mockImplementation(async () => {
      throw new Error("no activity found");
    });
    await renderCard();

    await press(screen.getByLabelText(SHARE));

    expect(screen.getByText("Couldn't open the share sheet.")).toBeTruthy();
    expect(screen.getByLabelText(DONE_GATED)).toBeTruthy();
  });
});

describe("WebhookSecretCard — the manual attestation", () => {
  it("ticking it unlocks Done, and un-ticking re-gates it", async () => {
    await renderCard();

    const tick = screen.getByLabelText(TICK);
    expect(tick.props.accessibilityState.checked).toBe(false);

    await press(tick);
    expect(screen.getByLabelText(TICK).props.accessibilityState.checked).toBe(
      true,
    );
    expect(screen.getByLabelText(DONE_READY)).toBeTruthy();

    // Changing your mind must close the door again — the tick is the claim,
    // and withdrawing the claim withdraws the permission.
    await press(screen.getByLabelText(TICK));
    expect(screen.getByLabelText(TICK).props.accessibilityState.checked).toBe(
      false,
    );
    expect(screen.getByLabelText(DONE_GATED)).toBeTruthy();
  });
});

describe("WebhookSecretCard — Done", () => {
  it("destroys the process stash after a copy, and stops rendering the value", async () => {
    await renderCard();
    await press(screen.getByLabelText(COPY));

    expect(peekSecret()?.value).toBe(SECRET);
    await press(screen.getByLabelText(DONE_READY));

    // Not a local flag: the shared stash that survives navigation is emptied,
    // so returning to this screen cannot resurrect the secret.
    expect(peekSecret()).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it("admits the dismissal cannot be taken back", async () => {
    // Captured by the tick rather than a copy so this assertion is about the
    // DISMISS toast and not about whichever notice is still on screen.
    await renderCard();
    await press(screen.getByLabelText(TICK));

    await press(screen.getByLabelText(DONE_READY));

    expect(
      screen.getByText("Secret dismissed. It can't be shown again."),
    ).toBeTruthy();
    expect(peekSecret()).toBeNull();
  });

  it("pressing the gated Done does nothing — no dismiss, no stash clear, no toast", async () => {
    await renderCard();

    await press(screen.getByLabelText(DONE_GATED));

    expect(onDismiss).not.toHaveBeenCalled();
    expect(peekSecret()?.value).toBe(SECRET);
    expect(screen.queryByText("Secret dismissed. It can't be shown again.")).toBeNull();
    expect(screen.getByText(SECRET)).toBeTruthy();
  });
});
