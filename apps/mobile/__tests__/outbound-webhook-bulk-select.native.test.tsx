/**
 * Multi-select bulk actions on outbound webhook endpoints — the render
 * contract for pause / resume / delete across a selection.
 *
 * THERE IS NO BULK ROUTE. Desktop's toolbar (pages/OutboundWebhooks.tsx,
 * `useCanonicalBulkActions`) fans every bulk verb out PER ID, and so does the
 * phone. That makes the failure modes here different from a single-row
 * action, and each one is asserted below:
 *
 *  1. THE FAN-OUT IS REAL, PER ID. A "bulk" control that quietly sends one
 *     request, or the same request twice, is indistinguishable on screen.
 *  2. RESUME IS `re-enable`, NOT `PATCH {active:true}`. A selection cannot
 *     tell a human-paused row from an auto-disabled one without each row's
 *     health rollup, and a bare active flip on an auto-disabled endpoint is
 *     undone by the delivery worker within minutes.
 *  3. A ROW ALREADY IN THE TARGET STATE IS NEVER SENT, AND NEVER COUNTED AS
 *     CHANGED. "Paused 5" for a run that paused 4 and no-op'd 1 is how an
 *     operator comes to believe a write touched rows it never touched.
 *  4. A FAILURE IS NAMED AND STAYS SELECTED. "Paused 5 of 7" with no further
 *     detail leaves the operator with no way to retry exactly the seven minus
 *     five; the server's own sentence names the repair.
 *  5. AN INERT VERB SAYS WHY. Role, connection, and "every selected webhook
 *     is already active" are sentences, not opacity.
 *
 * `useConfirm` and `useToast` are mocked rather than provided: what the
 * operator is ASKED before an irreversible delete, and what they are TOLD
 * afterwards, are the two things this feature is judged on, and both are
 * arguments rather than pixels.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * The three single-row routes a bulk verb fans out over. Stubbed at the API
 * seam, not at the hook, so the wiring under test is the real one:
 * bar → controller → partition → sequential loop → transport.
 */
const mockApi = {
  setActive: jest.fn<(id: string, active: boolean) => Promise<unknown>>(),
  reEnable: jest.fn<(id: string) => Promise<unknown>>(),
  remove:
    jest.fn<
      (id: string) => Promise<{ data: unknown; error: { message: string } | null }>
    >(),
};
const mockConfirm = jest.fn<(options: Record<string, unknown>) => Promise<boolean>>(
  async () => true,
);
const mockToast = jest.fn<(entry: { kind: string; message: string }) => void>();

jest.mock("@/api/outboundWebhooks", () => ({
  ...(jest.requireActual("@/api/outboundWebhooks") as object),
  setOutboundWebhookActive: (id: string, active: boolean) =>
    mockApi.setActive(id, active),
  reEnableOutboundWebhook: (id: string) => mockApi.reEnable(id),
}));
jest.mock("@/api/settings", () => ({
  ...(jest.requireActual("@/api/settings") as object),
  deleteOutboundWebhook: (id: string) => mockApi.remove(id),
}));
jest.mock("@/components/ConfirmSheet", () => ({ useConfirm: () => mockConfirm }));
jest.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: mockToast, dismiss: jest.fn() }),
}));

// eslint-disable-next-line import/first
import * as Gate from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import Webhooks from "../app/(tabs)/webhooks";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __setIsOnlineForTests: (value: boolean) => void;
  __resetOnlineGateForTests: () => void;
};

beforeEach(() => {
  mockApi.setActive.mockImplementation(async () => ({}));
  mockApi.reEnable.mockImplementation(async () => ({}));
  mockApi.remove.mockImplementation(async () => ({ data: {}, error: null }));
  mockConfirm.mockImplementation(async () => true);
});

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
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

const HOUR_MS = 60 * 60 * 1000;

/** Rows shaped exactly as GET /api/v1/outbound-webhooks marshals them. */
const WAREHOUSE = {
  id: "w1",
  url: "https://receiver.example.com/hooks/warehouse",
  description: "Data warehouse",
  events: ["campaign.sent"],
  active: true,
  created_at: "2026-07-01T09:00:00Z",
  last_succeeded_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
  consecutive_failures: 0,
};
const ANALYTICS = {
  ...WAREHOUSE,
  id: "w2",
  url: "https://receiver.example.com/hooks/analytics",
  description: "Analytics sink",
};
const PAUSED = {
  ...WAREHOUSE,
  id: "w3",
  url: "https://receiver.example.com/hooks/archive",
  description: "Archive sink",
  active: false,
};

function loadEndpoints(rows: readonly unknown[]) {
  queryHarness.__setQueryResultForTests({
    data: rows,
    error: null,
    fetchNextPage: jest.fn(async () => undefined),
    hasNextPage: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: rows })),
  });
}

/** The row's announcement while the list is NOT in selection mode. */
function collapsedRow(title: string, state = "active") {
  return screen.getByLabelText(new RegExp(`^${title}, ${state}\\.`, "u"));
}

/** The row's announcement once it has become a checkbox. */
function checkboxRow(title: string, state = "active") {
  return screen.getByLabelText(`${title}, ${state}.`);
}

async function enterSelection(title: string, state = "active") {
  await fireEvent(collapsedRow(title, state), "longPress");
}

describe("outbound webhook multi-select", () => {
  it("turns a long press into a selection the bar names", async () => {
    loadEndpoints([WAREHOUSE, ANALYTICS]);
    await render(<Webhooks />, { wrapper });
    // Nothing is selectable until the operator asks for it.
    expect(screen.queryByText("1 selected")).toBeNull();
    await enterSelection("Data warehouse");
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.getByLabelText("Pause")).toBeTruthy();
    expect(screen.getByLabelText("Resume")).toBeTruthy();
    expect(screen.getByLabelText("Delete")).toBeTruthy();
    expect(screen.getByLabelText("Leave selection mode")).toBeTruthy();
  });

  it("adds rows on tap, and stops a tap from expanding one instead", async () => {
    // A tap that opened the health panel while a bulk delete was being
    // assembled is exactly the misfire multi-select exists to avoid.
    loadEndpoints([WAREHOUSE, ANALYTICS]);
    await render(<Webhooks />, { wrapper });
    await enterSelection("Data warehouse");
    await fireEvent.press(checkboxRow("Analytics sink"));
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(checkboxRow("Data warehouse").props.accessibilityState.checked).toBe(
      true,
    );
    expect(
      screen.queryByLabelText(
        "Show the recent deliveries to Analytics sink, newest first, with replay.",
      ),
    ).toBeNull();
  });

  it("leaves selection mode when the last selected row is deselected", async () => {
    // Otherwise the operator is stranded in an empty bar whose every verb is
    // disabled, with no obvious way back to the list.
    loadEndpoints([WAREHOUSE, ANALYTICS]);
    await render(<Webhooks />, { wrapper });
    await enterSelection("Data warehouse");
    await fireEvent.press(checkboxRow("Data warehouse"));
    expect(screen.queryByText("1 selected")).toBeNull();
    expect(screen.queryByLabelText("Leave selection mode")).toBeNull();
  });

  it("republishes the long press as a VoiceOver action", async () => {
    // A long press has no affordance and the rotor cannot perform one, so
    // without this the whole feature is unreachable with a screen reader.
    loadEndpoints([WAREHOUSE]);
    await render(<Webhooks />, { wrapper });
    expect(collapsedRow("Data warehouse").props.accessibilityActions).toEqual([
      { name: "select", label: "Select webhooks" },
    ]);
    await fireEvent(collapsedRow("Data warehouse"), "accessibilityAction", {
      nativeEvent: { actionName: "select" },
    });
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("withholds selection entirely below admin rather than 403ing per row", async () => {
    // Every route a bulk verb reaches is admin in routeauth's manifest. An
    // editor who selects seven endpoints and collects seven 403s has been
    // taught nothing except not to trust the screen.
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    loadEndpoints([WAREHOUSE]);
    await render(<Webhooks />, { wrapper });
    const row = collapsedRow("Data warehouse");
    expect(row.props.accessibilityActions).toBeUndefined();
    await fireEvent(row, "longPress");
    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("says why Resume is inert instead of greying it out", async () => {
    loadEndpoints([WAREHOUSE, ANALYTICS]);
    await render(<Webhooks />, { wrapper });
    await enterSelection("Data warehouse");
    const resume = screen.getByLabelText("Resume");
    expect(resume.props.accessibilityState.disabled).toBe(true);
    expect(resume.props.accessibilityHint).toBe(
      "Every selected webhook is already active.",
    );
    // ...and the sentence is on screen, not only in the accessibility tree.
    expect(
      screen.getByText("Every selected webhook is already active."),
    ).toBeTruthy();
    // The counterweight: Pause is genuinely available for the same selection.
    expect(screen.getByLabelText("Pause").props.accessibilityState.disabled).toBe(
      false,
    );
  });

  it("refuses bulk actions offline, and says they are not queued", async () => {
    // Deliberately not queued: a pause resolved hours later acts on state the
    // operator has long since moved past.
    loadEndpoints([WAREHOUSE]);
    await render(<Webhooks />, { wrapper });
    await enterSelection("Data warehouse");
    gateHarness.__setIsOnlineForTests(false);
    await fireEvent.press(checkboxRow("Data warehouse"));
    await enterSelection("Data warehouse");
    const pause = screen.getByLabelText("Pause");
    expect(pause.props.accessibilityState.disabled).toBe(true);
    expect(
      screen.getByText(
        "You're offline. Bulk actions aren't queued — they need a connection.",
      ),
    ).toBeTruthy();
    await fireEvent.press(pause);
    expect(mockApi.setActive).not.toHaveBeenCalled();
  });
});

describe("outbound webhook bulk fan-out", () => {
  it("sends one PATCH per selected endpoint — there is no bulk route", async () => {
    loadEndpoints([WAREHOUSE, ANALYTICS]);
    await render(<Webhooks />, { wrapper });
    await enterSelection("Data warehouse");
    await fireEvent.press(checkboxRow("Analytics sink"));
    await fireEvent.press(screen.getByLabelText("Pause"));

    await waitFor(() => expect(mockApi.setActive).toHaveBeenCalledTimes(2));
    expect(mockApi.setActive.mock.calls).toEqual([
      ["w1", false],
      ["w2", false],
    ]);
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        kind: "success",
        message: "Paused 2 webhooks.",
      }),
    );
    // The selection is released once every row landed.
    await waitFor(() => expect(screen.queryByText("2 selected")).toBeNull());
  });

  it("asks before pausing, and states what pausing costs", async () => {
    loadEndpoints([WAREHOUSE, ANALYTICS]);
    await render(<Webhooks />, { wrapper });
    await enterSelection("Data warehouse");
    await fireEvent.press(checkboxRow("Analytics sink"));
    await fireEvent.press(screen.getByLabelText("Pause"));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    expect(mockConfirm.mock.calls[0]?.[0]).toMatchObject({
      title: "Pause 2 webhooks?",
      confirmLabel: "Pause",
      destructive: false,
    });
  });

  it("sends nothing when the confirmation is declined", async () => {
    // Without this the assertion above is decoration: a screen that ignored
    // the answer would satisfy it too.
    mockConfirm.mockImplementation(async () => false);
    loadEndpoints([WAREHOUSE, ANALYTICS]);
    await render(<Webhooks />, { wrapper });
    await enterSelection("Data warehouse");
    await fireEvent.press(screen.getByLabelText("Pause"));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    expect(mockApi.setActive).not.toHaveBeenCalled();
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("never sends a verb to a row already in that state, and counts it apart", async () => {
    loadEndpoints([WAREHOUSE, PAUSED]);
    await render(<Webhooks />, { wrapper });
    await enterSelection("Data warehouse");
    await fireEvent.press(checkboxRow("Archive sink", "paused"));
    await fireEvent.press(screen.getByLabelText("Pause"));

    await waitFor(() => expect(mockApi.setActive).toHaveBeenCalledTimes(1));
    expect(mockApi.setActive).toHaveBeenCalledWith("w1", false);
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        kind: "success",
        message: "Paused 1 webhook. 1 webhook already paused was skipped.",
      }),
    );
  });

  it("resumes through re-enable rather than a bare active flip", async () => {
    // `Store.ReEnable` re-validates destination, receiver auth, filter and
    // transform and clears the failure streak. PATCH {active:true} on an
    // auto-disabled endpoint is undone by the delivery worker — and a
    // selection cannot tell human-paused from auto-disabled apart.
    loadEndpoints([PAUSED]);
    await render(<Webhooks />, { wrapper });
    await enterSelection("Archive sink", "paused");
    await fireEvent.press(screen.getByLabelText("Resume"));

    await waitFor(() => expect(mockApi.reEnable).toHaveBeenCalledWith("w3"));
    expect(mockApi.setActive).not.toHaveBeenCalled();
    // Resume is the recovery verb; it does not stop to ask, exactly like the
    // single-row Resume on the expanded card.
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("keeps a refused endpoint selected, and quotes the server's own reason", async () => {
    mockApi.setActive.mockImplementation(async (id: string) => {
      if (id === "w2") {
        throw new Error("receiver returned 401 on 12 consecutive attempts");
      }
      return {};
    });
    loadEndpoints([WAREHOUSE, ANALYTICS]);
    await render(<Webhooks />, { wrapper });
    await enterSelection("Data warehouse");
    await fireEvent.press(checkboxRow("Analytics sink"));
    await fireEvent.press(screen.getByLabelText("Pause"));

    await waitFor(() => expect(mockApi.setActive).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        kind: "warning",
        message:
          'Paused 1 of 2. "Analytics sink" was left unchanged and stays selected for retry — receiver returned 401 on 12 consecutive attempts',
      }),
    );
    // Exactly the refused row stays selected, so the next tap retries it alone.
    await waitFor(() => expect(screen.getByText("1 selected")).toBeTruthy());
    expect(checkboxRow("Analytics sink").props.accessibilityState.checked).toBe(
      true,
    );
    expect(checkboxRow("Data warehouse").props.accessibilityState.checked).toBe(
      false,
    );
  });

  it("names what a bulk delete removes, states it cannot be undone, and DELETEs per id", async () => {
    loadEndpoints([WAREHOUSE, ANALYTICS]);
    await render(<Webhooks />, { wrapper });
    await enterSelection("Data warehouse");
    await fireEvent.press(checkboxRow("Analytics sink"));
    await fireEvent.press(screen.getByLabelText("Delete"));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    expect(mockConfirm.mock.calls[0]?.[0]).toMatchObject({
      title: "Delete 2 webhooks?",
      // The rows are NAMED, not counted: "2 webhooks" is not something anyone
      // can check before tapping.
      message: "Data warehouse, Analytics sink",
      destructive: true,
      consequence:
        "They disappear from this list immediately and stop receiving events. Delivery history is kept until retention purges it. This can't be undone from the app.",
    });
    await waitFor(() => expect(mockApi.remove).toHaveBeenCalledTimes(2));
    expect(mockApi.remove.mock.calls).toEqual([["w1"], ["w2"]]);
  });

  it("surfaces a delete the server refused through its envelope, not a silent success", async () => {
    // `deleteOutboundWebhook` returns {data, error} rather than throwing, so a
    // loop that only catches rejections would report a refusal as "Deleted".
    mockApi.remove.mockImplementation(async (id: string) =>
      id === "w2"
        ? { data: null, error: { message: "webhook is referenced by a flow" } }
        : { data: {}, error: null },
    );
    loadEndpoints([WAREHOUSE, ANALYTICS]);
    await render(<Webhooks />, { wrapper });
    await enterSelection("Data warehouse");
    await fireEvent.press(checkboxRow("Analytics sink"));
    await fireEvent.press(screen.getByLabelText("Delete"));

    await waitFor(() => expect(mockApi.remove).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        kind: "warning",
        message:
          'Deleted 1 of 2. "Analytics sink" was left unchanged and stays selected for retry — webhook is referenced by a flow',
      }),
    );
  });
});
