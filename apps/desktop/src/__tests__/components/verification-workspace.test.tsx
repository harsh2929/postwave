// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  canAdmin: true,
  roleStatus: "resolved",
  listJobs: vi.fn(),
  getJob: vi.fn(),
  jobResults: vi.fn(),
  cancelJob: vi.fn(),
  createJob: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  verificationApi: {
    listJobs: mocks.listJobs,
    getJob: mocks.getJob,
    jobResults: mocks.jobResults,
    cancelJob: mocks.cancelJob,
    createJob: mocks.createJob,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useRoleStatus: () => mocks.roleStatus,
}));

import { VerificationBulkPanel } from "../../components/deliverability/VerificationBulkPanel";

const RAW_SECRET = "Bearer should-never-render-private-upstream-token";
const JOB_ID = "71000000-0000-4000-8000-000000000001";
const SECOND_JOB_ID = "71000000-0000-4000-8000-000000000002";

const COMPLETED_JOB = {
  id: JOB_ID,
  status: "completed",
  source: "tag",
  source_ref: RAW_SECRET,
  provider: "zerobounce",
  total: 2,
  processed: 2,
  cache_hits: 1,
  local_filtered: 0,
  vendor_verified: 1,
  credits_spent: 1,
  duplicates: 0,
  created_at: "2026-08-02T09:00:00.000Z",
  started_at: "2026-08-02T09:00:01.000Z",
  completed_at: "2026-08-02T09:00:04.000Z",
};

const PENDING_JOB = {
  ...COMPLETED_JOB,
  status: "pending",
  source: "inline",
  total: 2,
  processed: 0,
  cache_hits: 0,
  local_filtered: 0,
  vendor_verified: 0,
  credits_spent: 0,
  duplicates: 0,
  started_at: undefined,
  completed_at: undefined,
};

const RESULTS = [
  {
    email: "private.recipient@example.invalid",
    processed: true,
    status: "valid",
    sub_status: RAW_SECRET,
    score: 9,
    provider: "zerobounce",
    billable: true,
    cached: false,
    checked_at: "2026-08-02T09:00:03.000Z",
  },
  {
    email: "another.recipient@example.invalid",
    processed: true,
    status: "invalid",
    provider: "zerobounce",
    billable: false,
    cached: true,
    did_you_mean: "another.corrected@example.invalid",
    checked_at: "2026-08-02T09:00:02.000Z",
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = true;
  mocks.roleStatus = "resolved";
  mocks.listJobs.mockReset();
  mocks.getJob.mockReset();
  mocks.jobResults.mockReset();
  mocks.cancelJob.mockReset();
  mocks.createJob.mockReset();
  mocks.listJobs.mockResolvedValue({ data: { jobs: [] } });
  mocks.getJob.mockResolvedValue({ data: jobDetail(COMPLETED_JOB) });
  mocks.jobResults.mockResolvedValue({ data: { results: RESULTS } });
  mocks.cancelJob.mockResolvedValue({ data: undefined });
  mocks.createJob.mockResolvedValue({ data: PENDING_JOB });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

async function renderPanel(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<VerificationBulkPanel />));
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

function button(label: string | RegExp): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => {
      const copy =
        candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
      return typeof label === "string"
        ? candidate.textContent?.trim() === label
        : label.test(copy);
    },
  );
  if (!(match instanceof HTMLButtonElement))
    throw new Error(`Button not found: ${String(label)}`);
  return match;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function jobDetail(
  job: typeof COMPLETED_JOB | Record<string, unknown>,
): Record<string, unknown> {
  const record = job as typeof COMPLETED_JOB;
  return {
    job,
    summary:
      record.processed === 2
        ? { valid: 1, invalid: 1 }
        : { valid: record.processed },
    credits_saved: Math.max(0, record.processed - record.credits_spent),
    credits_spent: record.credits_spent,
    is_terminal: ["completed", "failed", "canceled"].includes(record.status),
  };
}

describe("bulk verification containment workspace", () => {
  it("withholds every job request and control until admin authority resolves", async () => {
    mocks.canAdmin = false;
    await renderPanel();

    expect(document.body.textContent).toContain("Admin access required");
    expect(document.body.textContent).toContain("recipient-level evidence");
    expect(mocks.listJobs).not.toHaveBeenCalled();
    expect(mocks.getJob).not.toHaveBeenCalled();
    expect(mocks.jobResults).not.toHaveBeenCalled();
    expect(mocks.cancelJob).not.toHaveBeenCalled();
  });

  it("does not trust a stale admin flag while role authority is loading", async () => {
    mocks.canAdmin = true;
    mocks.roleStatus = "loading";
    await renderPanel();

    expect(document.body.textContent).toContain(
      "Loading bulk-verification permissions",
    );
    expect(mocks.listJobs).not.toHaveBeenCalled();
    expect(mocks.getJob).not.toHaveBeenCalled();
    expect(mocks.jobResults).not.toHaveBeenCalled();
    expect(mocks.cancelJob).not.toHaveBeenCalled();
  });

  it("makes no history claim when role authority is unavailable", async () => {
    mocks.canAdmin = true;
    mocks.roleStatus = "unavailable";
    await renderPanel();

    expect(document.body.textContent).toContain(
      "Permissions could not be verified",
    );
    expect(document.body.textContent).toContain(
      "No verification history or recipient evidence was requested",
    );
    expect(document.body.textContent).not.toContain("Admin access required");
    expect(mocks.listJobs).not.toHaveBeenCalled();
  });

  it("renders the durable start gate and an explicit, non-truncated history receipt", async () => {
    mocks.listJobs.mockResolvedValue({ data: { jobs: [COMPLETED_JOB] } });
    await renderPanel();

    expect(document.body.textContent).toContain("Durable async worker");
    expect(document.body.textContent).toContain(
      "uncertain submit safe to retry",
    );
    expect(document.body.textContent).toContain(
      "not truncated by the 50-run first-page limit",
    );
    expect(document.body.textContent).toContain("Start verification");
    expect(document.body.querySelector("input[type=file]")).toBeNull();
    expect(document.body.textContent).not.toContain(RAW_SECRET);
  });

  it("requires spend acknowledgement and preserves its idempotency key across an uncertain retry", async () => {
    mocks.createJob
      .mockResolvedValueOnce({
        error: { status: 500, message: `${RAW_SECRET} at private-host` },
      })
      .mockResolvedValueOnce({ data: PENDING_JOB });
    await renderPanel();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      "#verification-job-addresses",
    );
    if (!textarea) throw new Error("address textarea missing");
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(
        textarea,
        "person@example.com\nperson@example.com\nother@example.com",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();

    expect(button("Start verification").disabled).toBe(true);
    expect(document.body.textContent).toContain("3 submitted · 2 unique");
    const acknowledgement = document.querySelector<HTMLInputElement>(
      '.verification-checkbox-row input[type="checkbox"]',
    );
    if (!acknowledgement) throw new Error("acknowledgement missing");
    act(() => acknowledgement.click());

    await act(async () => {
      button("Start verification").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Run not confirmed");
    expect(document.body.textContent).not.toContain(RAW_SECRET);
    expect(document.body.textContent).not.toContain("private-host");

    await act(async () => {
      button("Start verification").click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.createJob).toHaveBeenCalledTimes(2);
    const firstKey = mocks.createJob.mock.calls[0]?.[1];
    const secondKey = mocks.createJob.mock.calls[1]?.[1];
    expect(firstKey).toMatch(/^desktop-verification-/u);
    expect(secondKey).toBe(firstKey);
    expect(mocks.createJob.mock.calls[0]?.[0]).toEqual({
      source: "inline",
      emails: ["person@example.com", "person@example.com", "other@example.com"],
    });
    expect(document.body.textContent).toContain("Verification run accepted");
  });

  it("states when the recent ledger may be truncated instead of inventing a total", async () => {
    const jobs = Array.from({ length: 50 }, (_, index) => ({
      ...COMPLETED_JOB,
      id: `71000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }));
    mocks.listJobs.mockResolvedValue({ data: { jobs } });
    await renderPanel();

    expect(document.body.textContent).toContain(
      "first 50 runs returned by the recent-history endpoint",
    );
    expect(document.body.textContent).toContain("older runs may exist");
    expect(document.body.textContent).not.toContain("of 50 total");
  });

  it("contains malformed history without claiming a trustworthy empty ledger", async () => {
    mocks.listJobs.mockResolvedValue({
      data: { jobs: [{ ...COMPLETED_JOB, total: -1 }] },
    });
    await renderPanel();

    expect(document.body.textContent).toContain(
      "Recent runs could not be verified",
    );
    expect(document.body.textContent).toContain("Run ledger unavailable.");
    expect(document.body.textContent).not.toContain(
      "No verification runs are recorded.",
    );
  });

  it("keeps the last verified ledger visible after a malformed refresh", async () => {
    mocks.listJobs
      .mockResolvedValueOnce({ data: { jobs: [COMPLETED_JOB] } })
      .mockResolvedValueOnce({ data: { unexpected: [] } });
    await renderPanel();

    await act(async () => {
      button("Refresh").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(
      "The last verified run ledger remains visible",
    );
    expect(button(/View completed verification run/u)).toBeDefined();
    expect(document.body.textContent).not.toContain(RAW_SECRET);
  });

  it("renders only masked terminal evidence and tells the truth about page completeness", async () => {
    mocks.listJobs.mockResolvedValue({ data: { jobs: [COMPLETED_JOB] } });
    await renderPanel();

    act(() => button(/View completed verification run/u).click());
    await settle();

    expect(mocks.getJob).toHaveBeenCalledWith(JOB_ID);
    expect(mocks.jobResults).toHaveBeenCalledWith(JOB_ID, {
      status: undefined,
      limit: 101,
      offset: 0,
    });
    expect(document.body.textContent).toContain("p••••••••@example.invalid");
    expect(document.body.textContent).toContain("a••••••••@example.invalid");
    expect(document.body.textContent).not.toContain(
      "private.recipient@example.invalid",
    );
    expect(document.body.textContent).not.toContain(RAW_SECRET);
    expect(document.body.textContent).toContain(
      "latest page returned no additional row",
    );
    expect(
      document.querySelector(".verification-results-table table"),
    ).not.toBeNull();
    expect(
      document
        .querySelector(".verification-results-table .pw-data-table__scroll")
        ?.getAttribute("tabindex"),
    ).toBe("0");
    expect(document.activeElement?.id).toBe("verification-progress-title");
  });

  it("labels unprocessed canceled rows without inventing a verdict or resolution", async () => {
    const canceled = {
      ...COMPLETED_JOB,
      status: "canceled",
      processed: 1,
      cache_hits: 0,
      vendor_verified: 1,
      credits_spent: 1,
    };
    mocks.listJobs.mockResolvedValue({ data: { jobs: [canceled] } });
    mocks.getJob.mockResolvedValue({ data: jobDetail(canceled) });
    mocks.jobResults.mockResolvedValue({
      data: {
        results: [
          RESULTS[0],
          {
            email: "waiting.recipient@example.invalid",
            processed: false,
            status: "unknown",
            billable: false,
            cached: false,
          },
        ],
      },
    });
    await renderPanel();

    act(() => button(/View canceled verification run/u).click());
    await settle();

    const body = document.body.textContent ?? "";
    expect(body.match(/Not processed/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(body).toContain("Failed or canceled runs can include rows");
    expect(body).not.toContain("waiting.recipient@example.invalid");
  });

  it("uses a sentinel row to prove more results without claiming a total", async () => {
    const largeJob = {
      ...COMPLETED_JOB,
      total: 101,
      processed: 101,
      cache_hits: 0,
      local_filtered: 0,
      vendor_verified: 101,
      credits_spent: 101,
    };
    const pages = Array.from({ length: 101 }, (_, index) => ({
      ...RESULTS[0],
      email: `person${index}@example.invalid`,
    }));
    mocks.listJobs.mockResolvedValue({ data: { jobs: [largeJob] } });
    mocks.getJob.mockResolvedValue({ data: jobDetail(largeJob) });
    mocks.jobResults.mockImplementation(
      (_id: string, options: { offset: number }) =>
        Promise.resolve({
          data: {
            results: options.offset === 100 ? pages.slice(100) : pages,
          },
        }),
    );
    await renderPanel();

    act(() => button(/View completed verification run/u).click());
    await settle();
    expect(document.body.textContent).toContain(
      "100 masked rows loaded. A sentinel row confirms more results exist",
    );
    expect(document.body.textContent).toContain(
      "the endpoint does not provide a total",
    );

    await act(async () => {
      button("Load more").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.jobResults).toHaveBeenLastCalledWith(JOB_ID, {
      status: undefined,
      limit: 101,
      offset: 100,
    });
    expect(document.body.textContent).toContain("101 masked rows loaded");
    expect(document.body.textContent).toContain(
      "latest page returned no additional row",
    );
  });

  it("requires a deliberate second step and verifies the cancellation receipt", async () => {
    const running = {
      ...COMPLETED_JOB,
      status: "running",
      total: 3,
      processed: 1,
      cache_hits: 0,
      vendor_verified: 1,
      credits_spent: 1,
      completed_at: undefined,
    };
    const canceled = {
      ...running,
      status: "canceled",
      completed_at: "2026-08-02T09:05:00.000Z",
    };
    mocks.listJobs.mockResolvedValue({ data: { jobs: [running] } });
    mocks.getJob
      .mockResolvedValueOnce({ data: jobDetail(running) })
      .mockResolvedValueOnce({ data: jobDetail(canceled) });
    mocks.jobResults.mockResolvedValue({ data: { results: [] } });
    await renderPanel();

    act(() => button(/View running verification run/u).click());
    await settle();
    act(() => button("Cancel run…").click());

    expect(mocks.cancelJob).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "A provider request already in flight can still settle",
    );
    await act(async () => {
      button("Confirm cancellation").click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.cancelJob).toHaveBeenCalledTimes(1);
    expect(mocks.cancelJob).toHaveBeenCalledWith(JOB_ID);
    expect(document.body.textContent).toContain("Cancellation confirmed");
    expect(document.body.textContent).toContain(
      "refresh the run before treating its credit count as final",
    );
  });

  it("bounds cancellation failures and never renders transport details", async () => {
    const running = {
      ...COMPLETED_JOB,
      status: "running",
      total: 3,
      processed: 1,
      cache_hits: 0,
      vendor_verified: 1,
      credits_spent: 1,
      completed_at: undefined,
    };
    mocks.listJobs.mockResolvedValue({ data: { jobs: [running] } });
    mocks.getJob.mockResolvedValue({ data: jobDetail(running) });
    mocks.cancelJob.mockResolvedValue({
      error: { message: `${RAW_SECRET} at postgres://private-host` },
    });
    await renderPanel();

    act(() => button(/View running verification run/u).click());
    await settle();
    act(() => button("Cancel run…").click());
    await act(async () => {
      button("Confirm cancellation").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(
      "Cancellation was not confirmed",
    );
    expect(document.body.textContent).toContain(
      "last verified run status remains authoritative",
    );
    expect(document.body.textContent).not.toContain(RAW_SECRET);
    expect(document.body.textContent).not.toContain("private-host");
  });

  it("ignores a late detail response after another run is selected", async () => {
    const firstRequest = deferred<{ data: Record<string, unknown> }>();
    const secondJob = {
      ...COMPLETED_JOB,
      id: SECOND_JOB_ID,
      total: 7,
      processed: 7,
      cache_hits: 4,
      local_filtered: 2,
      vendor_verified: 1,
      credits_spent: 1,
      created_at: "2026-08-02T08:00:00.000Z",
      started_at: "2026-08-02T08:00:01.000Z",
      completed_at: "2026-08-02T08:00:08.000Z",
    };
    mocks.listJobs.mockResolvedValue({
      data: { jobs: [COMPLETED_JOB, secondJob] },
    });
    mocks.getJob.mockImplementation((id: string) =>
      id === JOB_ID
        ? firstRequest.promise
        : Promise.resolve({ data: jobDetail(secondJob) }),
    );
    mocks.jobResults.mockResolvedValue({ data: { results: [] } });
    await renderPanel();

    const viewButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label*="verification run created"]',
      ),
    );
    act(() => viewButtons[0]?.click());
    act(() => viewButtons[1]?.click());
    await settle();
    expect(document.body.textContent).toContain("7 of 7");

    await act(async () => {
      firstRequest.resolve({ data: jobDetail(COMPLETED_JOB) });
      await firstRequest.promise;
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("7 of 7");
    expect(document.body.textContent).not.toContain("2 of 2");
  });

  it("drops late admin history after unmount", async () => {
    const request = deferred<{ data: { jobs: (typeof COMPLETED_JOB)[] } }>();
    mocks.listJobs.mockReturnValue(request.promise);
    await renderPanel();

    act(() => root?.unmount());
    root = null;
    await act(async () => {
      request.resolve({ data: { jobs: [COMPLETED_JOB] } });
      await request.promise;
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain("Uploaded list");
    expect(mocks.getJob).not.toHaveBeenCalled();
  });
});
