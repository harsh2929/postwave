/**
 * P3 — "verification job drill-in (status detail + per-address results pages)".
 *
 * The jobs panel could say "something is spending credits, stop it". It could
 * not say where the money went or WHICH addresses came back unsendable. This
 * suite pins the drill-in's load-bearing behaviours:
 *
 *  - the per-row reads are NOT fanned out: with the sheet shut, the results
 *    query is unarmed and the detail query has no id;
 *  - the row is the way in — pressing it opens the sheet for THAT job;
 *  - the failures scope is the default and asks the server for exactly the
 *    four verdicts Status.Sendable() rejects;
 *  - an empty failures page on an unfinished run never reads as an all-clear,
 *    and a failed results read never reads as "no failures";
 *  - the spend and progress sentences are the server's numbers, and an open
 *    sheet survives the job it was opened on finishing.
 *
 * Every request on this sheet is a GET; nothing here can spend a credit.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React, { type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockDetailIds: string[] = [];
const mockResultsCalls: {
  jobId: string;
  statuses: readonly string[];
  enabled: boolean;
  limit: number;
}[] = [];
const mockDetail: { data: unknown; isError: boolean } = {
  data: undefined,
  isError: false,
};
const mockResults: { data: unknown; isError: boolean; isPending: boolean } = {
  data: undefined,
  isError: false,
  isPending: false,
};
const mockJobs: { data: unknown; isError: boolean } = {
  data: undefined,
  isError: false,
};
const mockCancel = { mutate: jest.fn(), isPending: false };

jest.mock("@/hooks/useVerificationJobDetail", () => ({
  useVerificationJobDetail: (jobId: string) => {
    mockDetailIds.push(jobId);
    return mockDetail;
  },
  useVerificationJobResults: (input: {
    jobId: string;
    statuses: readonly string[];
    enabled: boolean;
    limit: number;
  }) => {
    mockResultsCalls.push(input);
    return mockResults;
  },
}));
jest.mock("@/hooks/useVerificationJobs", () => ({
  useVerificationJobs: () => mockJobs,
  useCancelVerificationJob: () => mockCancel,
}));
jest.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => jest.fn(async () => true),
}));

// eslint-disable-next-line import/first
import { VerificationJobDetailSheet } from "@/components/deliverability/VerificationJobDetailSheet";
// eslint-disable-next-line import/first
import { VerificationJobsPanel } from "@/components/deliverability/VerificationJobsPanel";
// eslint-disable-next-line import/first
import * as Gate from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import {
  parseVerificationJobDetail,
  parseVerificationJobResults,
} from "@/lib/verificationJobDetail";

const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

const JOB_ID = "018f47f2-9f25-7f73-8ec6-3fd483eb51dd";

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

/** A payload shaped exactly like GET /api/v1/verification/jobs/{id}. */
function detailWire(job: Record<string, unknown> = {}, extra = {}) {
  return {
    job: {
      id: JOB_ID,
      status: "running",
      source: "list",
      execution_mode: "full",
      provider: "zerobounce",
      total: 12000,
      processed: 4500,
      cache_hits: 900,
      local_filtered: 600,
      vendor_verified: 3000,
      duplicates: 0,
      ambiguous: 0,
      created_at: "2026-09-01T09:00:00Z",
      ...job,
    },
    summary: { valid: 3800, invalid: 500, catch_all: 150, spamtrap: 50 },
    credits_spent: 3000,
    credits_saved: 1500,
    is_terminal: false,
    ...extra,
  };
}

/** A payload shaped exactly like GET .../{id}/results. */
const RESULTS_WIRE = {
  results: [
    {
      email: "bad@example.com",
      processed: true,
      status: "invalid",
      sub_status: "mailbox_not_found",
      score: 2,
      provider: "zerobounce",
      billable: true,
      cached: false,
      checked_at: "2026-09-01T09:30:00Z",
    },
    {
      email: "trap@example.com",
      processed: true,
      status: "spamtrap",
      provider: "zerobounce",
      billable: false,
      cached: true,
      checked_at: "2026-09-01T09:31:00Z",
    },
  ],
};

afterEach(() => {
  gateHarness.__resetOnlineGateForTests();
  mockDetailIds.length = 0;
  mockResultsCalls.length = 0;
  mockCancel.mutate.mockReset();
  Object.assign(mockDetail, { data: undefined, isError: false });
  Object.assign(mockResults, {
    data: undefined,
    isError: false,
    isPending: false,
  });
  Object.assign(mockJobs, { data: undefined, isError: false });
});

describe("VerificationJobsPanel — the tap-through", () => {
  const RUNNING_JOB = {
    id: JOB_ID,
    status: "running",
    total: 12000,
    processed: 4500,
    createdAt: "2026-09-01T09:00:00Z",
  };

  it("does not fan out a per-row read while the sheet is shut", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockJobs.data = [RUNNING_JOB];
    await render(<VerificationJobsPanel />, { wrapper });
    // The list renders one row; the drill-in reads must still be dormant.
    expect(mockDetailIds.every((id) => id === "")).toBe(true);
    expect(mockResultsCalls.every((call) => call.enabled === false)).toBe(true);
  });

  it("opens the sheet on THAT job when its row is pressed", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockJobs.data = [RUNNING_JOB];
    mockDetail.data = parseVerificationJobDetail(detailWire());
    const screen = await render(<VerificationJobsPanel />, { wrapper });
    await fireEvent.press(
      screen.getByLabelText(/Open verification job detail/u),
    );
    await waitFor(() => expect(mockDetailIds).toContain(JOB_ID));
    expect(
      mockResultsCalls.some(
        (call) => call.jobId === JOB_ID && call.enabled === true,
      ),
    ).toBe(true);
  });

  it("keeps an OPEN drill-in alive once the job it was opened on finishes", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockJobs.data = [RUNNING_JOB];
    mockDetail.data = parseVerificationJobDetail(
      detailWire({ status: "completed" }, { is_terminal: true }),
    );
    const screen = await render(<VerificationJobsPanel />, { wrapper });
    await fireEvent.press(
      screen.getByLabelText(/Open verification job detail/u),
    );
    await waitFor(() => expect(mockDetailIds).toContain(JOB_ID));

    // The job leaves the running list; the sheet must not be unmounted with it.
    mockJobs.data = [];
    await screen.rerender(<VerificationJobsPanel />);
    expect(screen.getByText("Verification job")).toBeTruthy();
  });
});

describe("VerificationJobDetailSheet", () => {
  it("asks only for the verdicts Status.Sendable() rejects by default", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockDetail.data = parseVerificationJobDetail(detailWire());
    await render(
      <VerificationJobDetailSheet jobId={JOB_ID} onClose={() => undefined} />,
      { wrapper },
    );
    const call = mockResultsCalls.at(-1);
    expect(call?.enabled).toBe(true);
    expect([...(call?.statuses ?? [])].sort()).toEqual([
      "abuse",
      "do_not_mail",
      "invalid",
      "spamtrap",
    ]);
    // catch_all and unknown are sendable; filtering them out would drop most
    // B2B lists wholesale.
    expect(call?.statuses).not.toContain("catch_all");
    expect(call?.statuses).not.toContain("unknown");
  });

  it("reports the server's own spend and progress, hedged while running", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockDetail.data = parseVerificationJobDetail(detailWire());
    const screen = await render(
      <VerificationJobDetailSheet jobId={JOB_ID} onClose={() => undefined} />,
      { wrapper },
    );
    expect(
      screen.getByText(
        "4,500 of 12,000 addresses processed so far. 3,000 sent to the vendor · 900 already cached · 600 settled by the free local tier.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "3,000 credits spent so far · 1,500 saved by the cache and local tier. Remaining work can still spend credits.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Still running — the counts below cover only what has been processed so far.",
      ),
    ).toBeTruthy();
  });

  it("leads with the failing verdicts and flags them", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockDetail.data = parseVerificationJobDetail(detailWire());
    const screen = await render(
      <VerificationJobDetailSheet jobId={JOB_ID} onClose={() => undefined} />,
      { wrapper },
    );
    expect(screen.getByText("invalid 500")).toBeTruthy();
    expect(screen.getByText("spamtrap 50")).toBeTruthy();
    expect(screen.getByText("valid 3800")).toBeTruthy();
  });

  it("names each failing address and whether it cost a credit", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockDetail.data = parseVerificationJobDetail(detailWire());
    mockResults.data = parseVerificationJobResults(RESULTS_WIRE);
    const screen = await render(
      <VerificationJobDetailSheet jobId={JOB_ID} onClose={() => undefined} />,
      { wrapper },
    );
    expect(screen.getByText("bad@example.com")).toBeTruthy();
    expect(
      screen.getByText(
        "invalid · mailbox not found · score 2 · vendor credit spent",
      ),
    ).toBeTruthy();
    expect(screen.getByText("spamtrap · from cache")).toBeTruthy();
  });

  it("never reads as an all-clear while the run is unfinished", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockDetail.data = parseVerificationJobDetail(detailWire());
    mockResults.data = parseVerificationJobResults({ results: [] });
    const screen = await render(
      <VerificationJobDetailSheet jobId={JOB_ID} onClose={() => undefined} />,
      { wrapper },
    );
    expect(
      screen.getByText(
        "No unsendable addresses among the ones processed so far — this run is not finished.",
      ),
    ).toBeTruthy();
  });

  it("can call a FINISHED run clean", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockDetail.data = parseVerificationJobDetail(
      detailWire({ status: "completed" }, { is_terminal: true }),
    );
    mockResults.data = parseVerificationJobResults({ results: [] });
    const screen = await render(
      <VerificationJobDetailSheet jobId={JOB_ID} onClose={() => undefined} />,
      { wrapper },
    );
    expect(
      screen.getByText("No unsendable addresses were found in this run."),
    ).toBeTruthy();
  });

  it("never renders a failed results read as 'no failures'", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockDetail.data = parseVerificationJobDetail(detailWire());
    mockResults.isError = true;
    const screen = await render(
      <VerificationJobDetailSheet jobId={JOB_ID} onClose={() => undefined} />,
      { wrapper },
    );
    expect(
      screen.getByText(/which\s+addresses failed is unknown/u),
    ).toBeTruthy();
    expect(screen.queryByText(/No unsendable addresses/u)).toBeNull();
  });

  it("never renders a failed detail read as a finished job", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockDetail.isError = true;
    const screen = await render(
      <VerificationJobDetailSheet jobId={JOB_ID} onClose={() => undefined} />,
      { wrapper },
    );
    expect(
      screen.getByText(/its progress and\s+spend are unknown/u),
    ).toBeTruthy();
    expect(screen.queryByText(/credits spent/u)).toBeNull();
  });

  it("says the detail cannot be read offline", async () => {
    gateHarness.__setOnlineGateForTests({
      effectiveRole: "viewer",
      enabled: false,
    });
    const screen = await render(
      <VerificationJobDetailSheet jobId={JOB_ID} onClose={() => undefined} />,
      { wrapper },
    );
    expect(
      screen.getByText("This job's detail can't be read offline."),
    ).toBeTruthy();
  });

  it("renders the server's sanitised failure sentence rather than a paraphrase", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockDetail.data = parseVerificationJobDetail(
      detailWire(
        {
          status: "failed",
          error: "The verification job failed.",
          failure_code: "provider_unavailable",
        },
        { is_terminal: true },
      ),
    );
    const screen = await render(
      <VerificationJobDetailSheet jobId={JOB_ID} onClose={() => undefined} />,
      { wrapper },
    );
    expect(screen.getByText("The verification job failed.")).toBeTruthy();
  });

  it("never lets a capped page read as the complete failure list", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    // The server's summary says 550 unsendable; the page holds 50.
    mockDetail.data = parseVerificationJobDetail(
      detailWire({}, { summary: { valid: 3800, invalid: 500, spamtrap: 50 } }),
    );
    mockResults.data = parseVerificationJobResults({
      results: Array.from({ length: 50 }, (_, i) => ({
        email: `bad${i}@example.com`,
        processed: true,
        status: "invalid",
        provider: "zerobounce",
        billable: true,
      })),
    });
    const screen = await render(
      <VerificationJobDetailSheet jobId={JOB_ID} onClose={() => undefined} />,
      { wrapper },
    );
    expect(
      screen.getByText("Showing 50 of 550 unsendable addresses."),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        "Show more addresses from this verification job",
      ),
    ).toBeTruthy();
  });

  it("asks the server for one more page when 'show more' is pressed", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockDetail.data = parseVerificationJobDetail(
      detailWire({}, { summary: { invalid: 500 } }),
    );
    mockResults.data = parseVerificationJobResults({
      results: Array.from({ length: 50 }, (_, i) => ({
        email: `bad${i}@example.com`,
        processed: true,
        status: "invalid",
        provider: "zerobounce",
      })),
    });
    const screen = await render(
      <VerificationJobDetailSheet jobId={JOB_ID} onClose={() => undefined} />,
      { wrapper },
    );
    expect(mockResultsCalls.at(-1)?.limit).toBe(50);
    await fireEvent.press(
      screen.getByLabelText("Show more addresses from this verification job"),
    );
    await waitFor(() => expect(mockResultsCalls.at(-1)?.limit).toBe(100));
  });

  it("offers no 'show more' when the page IS the whole list", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockDetail.data = parseVerificationJobDetail(
      detailWire({}, { summary: { invalid: 1, spamtrap: 1 } }),
    );
    mockResults.data = parseVerificationJobResults(RESULTS_WIRE);
    const screen = await render(
      <VerificationJobDetailSheet jobId={JOB_ID} onClose={() => undefined} />,
      { wrapper },
    );
    expect(screen.queryByText(/^Showing /u)).toBeNull();
    expect(
      screen.queryByLabelText(
        "Show more addresses from this verification job",
      ),
    ).toBeNull();
  });

  it("resets to one page when the scope changes", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockDetail.data = parseVerificationJobDetail(
      detailWire({}, { summary: { invalid: 500 } }),
    );
    mockResults.data = parseVerificationJobResults({
      results: Array.from({ length: 50 }, (_, i) => ({
        email: `bad${i}@example.com`,
        processed: true,
        status: "invalid",
      })),
    });
    const screen = await render(
      <VerificationJobDetailSheet jobId={JOB_ID} onClose={() => undefined} />,
      { wrapper },
    );
    await fireEvent.press(
      screen.getByLabelText("Show more addresses from this verification job"),
    );
    await waitFor(() => expect(mockResultsCalls.at(-1)?.limit).toBe(100));
    // "All" has a different total; carrying 100 across would ask for a page
    // the other scope may not have.
    await fireEvent.press(screen.getByLabelText("All"));
    await waitFor(() => expect(mockResultsCalls.at(-1)?.limit).toBe(50));
  });

  it("spends nothing: the drill-in offers no mutation at all", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockDetail.data = parseVerificationJobDetail(detailWire());
    mockResults.data = parseVerificationJobResults(RESULTS_WIRE);
    await render(
      <VerificationJobDetailSheet jobId={JOB_ID} onClose={() => undefined} />,
      { wrapper },
    );
    expect(mockCancel.mutate).not.toHaveBeenCalled();
  });
});
