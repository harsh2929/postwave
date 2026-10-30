/**
 * ProductEventExportAction — the only way the event feed leaves the phone.
 *
 * This action hands data to an app the operator picks from the OS share sheet,
 * so the costly failures are all about what goes OUT:
 *
 *  - THE FEED, NOT A LINK. A `/api/v1/track/events.csv` URL opens
 *    unauthenticated in the recipient's browser and fetches nothing, so the
 *    share sheet must receive the CSV TEXT.
 *  - THE PAYLOAD COLUMN NEVER SHIPS. `properties_json` is the most PII-dense
 *    field in the row and it is dropped, header and all.
 *  - A FORMULA NEVER EXECUTES. A leading `=`/`+`/`-`/`@` in any cell is
 *    neutralised before the text leaves, because the recipient pastes it into
 *    a spreadsheet.
 *  - AN EMPTY WINDOW IS NOT A SHARE. Opening the sheet with a header-only CSV
 *    is a broken promise; the reader is told there was nothing to export.
 *  - OFFLINE AND MID-FLIGHT, THE BUTTON REFUSES rather than firing twice.
 *
 * The bounding and escaping rules are pinned in
 * src/lib/productEventsExport.test.ts; this file proves the tap is wired to
 * them and that the share sheet gets what those rules produced.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";
import { Share } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ProductEventExportAction } from "@/components/product-events/ProductEventExportAction";
import { ToastProvider } from "@/components/Toast";

const queryHooks = require("./mocks/queryHooks.cjs");

const mockFetchCsv = jest.fn<
  (input: { days: number; eventName?: string }) => Promise<string>
>();
jest.mock("@/api/productEventsExport", () => ({
  fetchProductEventsCsv: (input: { days: number; eventName?: string }) =>
    mockFetchCsv(input),
}));

const HEADER =
  "id,occurred_at,received_at,subscriber_id,event_name,properties_json";

const LABEL = "Export the last 30 days of product events as CSV";

// jest.routes.config.cjs sets restoreMocks, so the spy is installed per test:
// a module-scope spy silently reverts to the REAL native Share after the first.
let shareSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  shareSpy = jest
    .spyOn(Share, "share")
    .mockResolvedValue({ action: "sharedAction" } as never);
});

afterEach(() => {
  mockFetchCsv.mockReset();
  queryHooks.__resetOnlineGateForTests();
});

function renderAction(days = 30) {
  return render(<ProductEventExportAction days={days} />, {
    wrapper: ({ children }) => (
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <ToastProvider>{children}</ToastProvider>
      </SafeAreaProvider>
    ),
  });
}

describe("ProductEventExportAction", () => {
  it("hands the share sheet the CSV text, without the payload column", async () => {
    mockFetchCsv.mockResolvedValue(
      [
        HEADER,
        `1,2026-08-30T10:00:00Z,2026-08-30T10:00:01Z,sub-1,purchase,"{""card"":""4242""}"`,
      ].join("\n"),
    );

    const screen = await renderAction();
    await fireEvent.press(screen.getByLabelText(LABEL));

    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    const shared = shareSpy.mock.calls[0]?.[0] as {
      message: string;
      title: string;
    };
    expect(mockFetchCsv).toHaveBeenCalledWith({ days: 30 });
    expect(shared.message.split("\n")[0]).toBe(
      "id,occurred_at,received_at,subscriber_id,event_name",
    );
    expect(shared.message).toContain("purchase");
    expect(shared.message).not.toContain("4242");
    expect(shared.message).not.toContain("properties_json");
    // Never a URL to a route the recipient cannot authenticate against.
    expect(shared.message).not.toContain("/api/v1/track");
    expect(shared.title).toContain("last 30 days");
  });

  it("neutralises a formula before the text reaches another app", async () => {
    mockFetchCsv.mockResolvedValue(
      [
        HEADER,
        `2,2026-08-30T10:00:00Z,2026-08-30T10:00:01Z,sub-2,"=cmd|'/c calc'!A1","{}"`,
      ].join("\n"),
    );

    const screen = await renderAction();
    await fireEvent.press(screen.getByLabelText(LABEL));

    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    const shared = shareSpy.mock.calls[0]?.[0] as { message: string };
    // The apostrophe makes the spreadsheet read it as text. No quoting is
    // added because the cell has no comma of its own — the guard is the
    // prefix, not the quotes.
    expect(shared.message).toContain(`sub-2,'=cmd|'/c calc'!A1`);
    expect(shared.message).not.toContain(`sub-2,=cmd`);
  });

  it("says the properties are missing rather than letting the file imply completeness", async () => {
    mockFetchCsv.mockResolvedValue(
      [HEADER, `1,2026-08-30T10:00:00Z,2026-08-30T10:00:01Z,sub-1,purchase,{}`].join(
        "\n",
      ),
    );

    const screen = await renderAction();
    await fireEvent.press(screen.getByLabelText(LABEL));

    expect(
      await screen.findByText(
        "Shared 1 event. Event properties aren't included; the web export has them.",
      ),
    ).toBeTruthy();
  });

  it("never opens the share sheet for an empty window", async () => {
    mockFetchCsv.mockResolvedValue(HEADER);

    const screen = await renderAction();
    await fireEvent.press(screen.getByLabelText(LABEL));

    expect(
      await screen.findByText(
        "No events in this window — there was nothing to export.",
      ),
    ).toBeTruthy();
    expect(shareSpy).not.toHaveBeenCalled();
  });

  it("reports a failed read instead of sharing a truncated or empty file", async () => {
    mockFetchCsv.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 }),
    );

    const screen = await renderAction();
    await fireEvent.press(screen.getByLabelText(LABEL));

    await waitFor(() => expect(mockFetchCsv).toHaveBeenCalledTimes(1));
    expect(shareSpy).not.toHaveBeenCalled();
    // A 403 reads as a permission rule, not as "the export is broken" and
    // certainly not as an empty feed.
    expect(
      await screen.findByText(
        "You don't have access to this. Ask a workspace administrator if you need it.",
      ),
    ).toBeTruthy();
  });

  it("refuses offline rather than queueing an export that cannot be queued", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });

    const screen = await renderAction();
    const button = screen.getByLabelText(LABEL);
    expect(button.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(button);
    expect(mockFetchCsv).not.toHaveBeenCalled();
  });
});
