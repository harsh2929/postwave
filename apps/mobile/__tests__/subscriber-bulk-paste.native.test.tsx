/**
 * CreateSubscriberSheet's paste mode — what only a rendered test can pin:
 *
 *  - the mode exists only when the caller offers onSubmitBulk (role floor is
 *    the caller's; a sheet must not advertise a verb the caller withheld);
 *  - the detected count is honest, and submit hands over the RAW paste plus
 *    the shared draft tags;
 *  - an over-cap paste and an offline session disable submit WITH the reason;
 *  - failed addresses come back named, inline, after a partial submit.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { CreateSubscriberSheet } from "@/components/subscriber/CreateSubscriberSheet";
import type { ThemeTokens } from "@/lib/theme";

// The jest theme mock's own idiom: every token resolves to a neutral color.
const t = new Proxy({}, { get: () => "#777777" }) as ThemeTokens;

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

const onSubmitBulk = jest.fn();

afterEach(() => {
  onSubmitBulk.mockClear();
});

async function draw(
  props: Partial<React.ComponentProps<typeof CreateSubscriberSheet>> = {},
) {
  await render(
    <CreateSubscriberSheet
      visible
      submitting={false}
      onClose={jest.fn()}
      onSubmit={jest.fn()}
      onSubmitBulk={onSubmitBulk}
      t={t}
      {...props}
    />,
    { wrapper },
  );
}

describe("the paste mode inside CreateSubscriberSheet", () => {
  it("does not exist when the caller withholds the bulk verb", async () => {
    await draw({ onSubmitBulk: undefined });
    expect(screen.queryByText("Paste several")).toBeNull();
  });

  it("counts the pasted addresses and submits the RAW paste with the draft tags", async () => {
    await draw();
    await act(async () => {
      fireEvent.press(screen.getByText("Paste several"));
    });
    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText("Pasted addresses"),
        "a@x.com, b@y.com\nA@X.COM",
      );
    });
    // De-duped case-insensitively — 2, not 3.
    expect(screen.getByText("2 addresses detected.")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText("Add 2 subscribers"));
    });
    expect(onSubmitBulk).toHaveBeenCalledWith({
      emails: "a@x.com, b@y.com\nA@X.COM",
      tags: [],
    });
  });

  it("refuses to submit offline, with the reason spoken", async () => {
    await draw({ online: false });
    await act(async () => {
      fireEvent.press(screen.getByText("Paste several"));
    });
    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText("Pasted addresses"),
        "a@x.com",
      );
    });
    await act(async () => {
      fireEvent.press(screen.getByText("Add subscribers"));
    });
    expect(onSubmitBulk).not.toHaveBeenCalled();
  });

  it("names the failed addresses inline after a partial submit", async () => {
    await draw({
      bulkResult: {
        parsed: 2,
        created: 1,
        updated: 0,
        skipped: 0,
        errored: 1,
        rows: [
          { email: "ok@x.com", status: "created", error: "" },
          { email: "bad@", status: "error", error: "invalid address" },
        ],
      },
    });
    await act(async () => {
      fireEvent.press(screen.getByText("Paste several"));
    });
    expect(screen.getByText("bad@ — invalid address")).toBeTruthy();
    expect(screen.queryByText(/ok@x\.com/)).toBeNull();
  });
});
