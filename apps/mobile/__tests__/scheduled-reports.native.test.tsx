import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";

/**
 * ScheduledReportsSection — the phone slice of recurring digest emails.
 *
 * Four claims are pinned here because each one is a way this surface could
 * lie to an operator who is deciding whether to stop a send:
 *
 *   - IT IS ADMIN-ONLY. Every route is `RequireScope(ScopeAdmin)`, which on a
 *     dashboard session is enforced as owner|admin. A viewer must see NOTHING,
 *     not a section that renders a 403 — and the query must not even be
 *     enabled for them.
 *   - BROKEN SORTS FIRST. The server orders by authoring date, which is the
 *     one ordering that never matches why anyone opens this list.
 *   - A NEVER-RUN REPORT IS NOT A ZERO-DELIVERY REPORT. The list SQL COALESCEs
 *     the per-run counters to 0, so a naive read prints "Last run: 0
 *     recipients" for a report that has never fired.
 *   - PAUSING GOES THROUGH THE CONFIRM SHEET and only then hits the wire.
 *
 * Mock shapes match the hooks' real return types: `useScheduledReports`
 * resolves to `ScheduledReportRow[]` (already parsed by lib/scheduledReports),
 * not to a raw wire payload (house rule 10).
 */
import type { ScheduledReportRow } from "@/lib/scheduledReports";

const NOW = Date.parse("2026-07-26T12:00:00Z");

/**
 * The card's informational half is ONE accessibility element (so VoiceOver
 * reads a sentence rather than six fragments), which means its Text nodes are
 * hidden from the a11y tree on purpose. Query them explicitly — the action
 * buttons deliberately sit OUTSIDE that element and need no flag.
 */
const HIDDEN = { includeHiddenElements: true } as const;

function row(over: Partial<ScheduledReportRow> = {}): ScheduledReportRow {
  return {
    id: "r1",
    name: "Weekly exec digest",
    enabled: true,
    template: "campaign_summary",
    schedule: "weekly:mon@09:00",
    timezone: "UTC",
    recipients: ["ops@acme.com", "cfo@acme.com"],
    lastRunAt: "2026-07-20T09:00:00Z",
    lastRunError: "",
    latestRunId: "run-1",
    latestRunStatus: "completed",
    acceptedCount: 2,
    failedCount: 0,
    recipientCount: 2,
    nextDueAt: "2026-07-27T09:00:00Z",
    ...over,
  };
}

const mockState = {
  rows: [row()] as ScheduledReportRow[],
  role: "owner" as string,
  enabledCalls: [] as { id: string; enabled: boolean }[],
  sendNowCalls: [] as string[],
  queryEnabledWith: [] as boolean[],
  confirmAnswer: true,
};

jest.mock("@/hooks/useScheduledReports", () => ({
  SCHEDULED_REPORTS_KEY: "scheduled-reports",
  useScheduledReports: (allowed: boolean) => {
    mockState.queryEnabledWith.push(allowed);
    return {
      data: allowed ? mockState.rows : undefined,
      isLoading: false,
      isError: false,
      isFetching: false,
      isSuccess: allowed,
      refetch: jest.fn(async () => undefined),
    };
  },
  useSetScheduledReportEnabled: () => ({
    mutateAsync: async (input: { id: string; enabled: boolean }) => {
      mockState.enabledCalls.push(input);
      return undefined;
    },
    isPending: false,
  }),
  useSendScheduledReportNow: () => ({
    mutateAsync: async (id: string) => {
      mockState.sendNowCalls.push(id);
      return undefined;
    },
    isPending: false,
  }),
}));

jest.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => async () => mockState.confirmAnswer,
}));

jest.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => ({
    enabled: true,
    baseUrl: "https://api.moosewave.com",
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    effectiveRole: mockState.role,
    canReadOfflineSnapshots: true,
  }),
}));

// eslint-disable-next-line import/first
import { ScheduledReportsSection } from "@/components/analytics/ScheduledReportsSection";

beforeEach(() => {
  mockState.rows = [row()];
  mockState.role = "owner";
  mockState.enabledCalls = [];
  mockState.sendNowCalls = [];
  mockState.queryEnabledWith = [];
  mockState.confirmAnswer = true;
});

async function renderSection() {
  return await render(
    React.createElement(ScheduledReportsSection, { now: NOW }),
  );
}

describe("ScheduledReportsSection", () => {
  it("renders the schedule in words with its timezone", async () => {
    const screen = await renderSection();
    expect(screen.getByText("Weekly exec digest", HIDDEN)).toBeTruthy();
    expect(
      screen.getByText("Weekly on Monday at 09:00 UTC", HIDDEN),
    ).toBeTruthy();
  });

  it("renders nothing at all for a viewer, and does not enable the query", async () => {
    mockState.role = "viewer";
    const screen = await renderSection();
    expect(screen.queryByText("Scheduled reports")).toBeNull();
    expect(screen.queryByText("Weekly exec digest")).toBeNull();
    // The gate reaches the hook too — a viewer must not spend a request to be
    // told 403.
    expect(mockState.queryEnabledWith.every((v) => v === false)).toBe(true);
  });

  it("puts a failing report above a healthy one, whatever order the server sent", async () => {
    mockState.rows = [
      row({ id: "healthy", name: "Healthy digest" }),
      row({ id: "broken", name: "Broken digest", lastRunError: "SMTP 550" }),
    ];
    const screen = await renderSection();
    const names = screen
      .getAllByText(/digest/i, HIDDEN)
      .map((node) => String(node.props.children));
    expect(names.indexOf("Broken digest")).toBeLessThan(
      names.indexOf("Healthy digest"),
    );
    expect(screen.getByText("SMTP 550", HIDDEN)).toBeTruthy();
  });

  it("never reports a never-run digest as a zero-delivery one", async () => {
    mockState.rows = [
      row({
        latestRunId: null,
        latestRunStatus: null,
        acceptedCount: null,
        failedCount: null,
        recipientCount: null,
        lastRunAt: null,
      }),
    ];
    const screen = await renderSection();
    expect(screen.getByText("Has not run yet.", HIDDEN)).toBeTruthy();
    expect(screen.queryByText(/0 recipients/, HIDDEN)).toBeNull();
  });

  it("pauses through the confirm sheet and sends enabled:false", async () => {
    const screen = await renderSection();
    fireEvent.press(screen.getByLabelText("Pause Weekly exec digest"));
    await waitFor(() => expect(mockState.enabledCalls).toHaveLength(1));
    expect(mockState.enabledCalls[0]).toEqual({ id: "r1", enabled: false });
  });

  it("does not touch the wire when the confirm sheet is dismissed", async () => {
    mockState.confirmAnswer = false;
    const screen = await renderSection();
    fireEvent.press(screen.getByLabelText("Pause Weekly exec digest"));
    await waitFor(() => expect(mockState.queryEnabledWith.length).toBeGreaterThan(0));
    expect(mockState.enabledCalls).toHaveLength(0);
  });

  it("offers Resume — not Pause — for an already-paused report", async () => {
    mockState.rows = [row({ enabled: false, nextDueAt: null })];
    const screen = await renderSection();
    expect(screen.getByLabelText("Resume Weekly exec digest")).toBeTruthy();
    expect(screen.queryByLabelText("Pause Weekly exec digest")).toBeNull();
    expect(
      screen.getByText("Paused — it will not send.", HIDDEN),
    ).toBeTruthy();
  });

  it("queues one manual run from Send now", async () => {
    const screen = await renderSection();
    fireEvent.press(screen.getByLabelText("Send Weekly exec digest now"));
    await waitFor(() => expect(mockState.sendNowCalls).toEqual(["r1"]));
  });

  it("speaks the whole row as one sentence for VoiceOver", async () => {
    const screen = await renderSection();
    const spoken = screen.getByLabelText(/Weekly exec digest scheduled\./);
    expect(spoken).toBeTruthy();
    expect(String(spoken.props.accessibilityLabel)).toContain(
      "Weekly on Monday at 09:00 UTC",
    );
    expect(String(spoken.props.accessibilityLabel)).toContain("2 recipients");
  });
});
