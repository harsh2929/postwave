// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
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

import type { Segment } from "../../components/segments/segmentsClient";
import { resetLifecycleCoordinatorForTests } from "../../lib/lifecycle-coordinator";

const mocks = vi.hoisted(() => ({
  canWrite: true,
  recompute: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanWrite: () => mocks.canWrite,
}));

vi.mock("../../components/segments/segmentsClient", () => ({
  segmentsClient: { recompute: mocks.recompute },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../components/segments/SegmentSnapshotsSection", () => ({
  SegmentSnapshotsSection: ({
    segmentId,
    canMutate,
  }: {
    segmentId: string;
    canMutate: boolean;
  }) => (
    <section
      aria-label="Evaluation snapshots"
      data-segment-id={segmentId}
      data-can-mutate={String(canMutate)}
    >
      Bounded evaluation records; not a complete immutable recipient list.
    </section>
  ),
}));

vi.mock("../../components/segments/SegmentPnLPanel", () => ({
  SegmentPnLPanel: ({ segmentId }: { segmentId: string }) => (
    <section aria-label="Segment profit and loss">
      P&amp;L for {segmentId}
    </section>
  ),
}));

vi.mock("../../components/segments/SegmentGrowthReport", () => ({
  SegmentGrowthReport: ({ segmentId }: { segmentId: string }) => (
    <section aria-label="Segment growth">Growth for {segmentId}</section>
  ),
}));

vi.mock("../../components/segments/SegmentDecaySection", () => ({
  SegmentDecaySection: ({ segmentId }: { segmentId: string }) => (
    <section aria-label="Segment decay">Decay for {segmentId}</section>
  ),
}));

import { SegmentDetailSlideover } from "../../components/segments/SegmentDetailSlideover";

const EVALUATED_AT = "2026-07-16T08:30:00.000Z";
const CREATED_AT = "2026-06-01T09:00:00.000Z";
const UPDATED_AT = "2026-07-15T10:15:00.000Z";

const alpha: Segment = {
  id: "segment-alpha-complete-identifier-001",
  tenantId: "workspace-complete-identifier-009",
  name: "High-intent readers",
  description: "Readers who opened recently and visited the pricing page.",
  queryAst: {
    op: "and",
    children: [
      { op: "condition", field: "email.opens", comparator: "gte", value: 2 },
    ],
  },
  lastCount: 1250,
  lastEvaluatedAt: EVALUATED_AT,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  kind: "ai",
};

const beta: Segment = {
  ...alpha,
  id: "segment-beta-complete-identifier-002",
  name: "New readers",
  lastCount: 80,
  lastEvaluatedAt: "2026-07-16T09:00:00.000Z",
  kind: "dynamic",
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canWrite = true;
  mocks.recompute.mockResolvedValue({
    data: { count: 1300, scheduled_at: "2026-07-17T07:45:00.000Z" },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  resetLifecycleCoordinatorForTests();
});

function render(node: ReactElement): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
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

function dispatchEscape(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    );
  });
}

describe("SegmentDetailSlideover production interaction maturity", () => {
  it("exposes complete record provenance, focusable permission reasons, snapshot truth, and an accessible dialog", async () => {
    mocks.canWrite = false;
    const onClose = vi.fn();
    const onDelete = vi.fn();
    render(
      <SegmentDetailSlideover
        segment={alpha}
        onClose={onClose}
        onDelete={onDelete}
      />,
    );
    await flush();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.textContent).toContain(alpha.id);
    expect(dialog?.textContent).toContain(alpha.tenantId);
    expect(dialog?.textContent).toContain("AI-suggested");
    expect(dialog?.textContent).toContain("Type provenance");
    expect(dialog?.textContent).toContain("Count provenance");
    expect(dialog?.textContent).toContain(
      "Cached from the latest server-confirmed evaluation",
    );
    expect(dialog?.textContent).toContain("Jul");
    expect(dialog?.textContent).toContain(
      "not a complete immutable recipient list",
    );
    expect(
      dialog
        ?.querySelector('[aria-label="Evaluation snapshots"]')
        ?.getAttribute("data-segment-id"),
    ).toBe(alpha.id);
    expect(
      dialog
        ?.querySelector('[aria-label="Evaluation snapshots"]')
        ?.getAttribute("data-can-mutate"),
    ).toBe("false");
    expect(dialog?.querySelector("[title]")).toBeNull();

    const recompute = button("Recompute now");
    const remove = button("Delete segment");
    expect(recompute.disabled).toBe(false);
    expect(remove.disabled).toBe(false);
    expect(recompute.getAttribute("aria-disabled")).toBe("true");
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "An editor or administrator role is required to recompute segments.",
    );
    act(() => {
      recompute.click();
      remove.click();
    });
    expect(mocks.recompute).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(recompute);

    const predicateSummary = dialog?.querySelector<HTMLElement>("summary");
    act(() => predicateSummary?.click());
    expect(predicateSummary?.closest("details")?.open).toBe(true);
    expect(dialog?.textContent).toContain('"field": "email.opens"');

    dispatchEscape();
    expect(onClose).toHaveBeenCalledTimes(1);

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("blocks an incomplete definition and labels malformed cached metadata instead of trusting it", async () => {
    const incomplete: Segment = {
      ...alpha,
      queryAst: undefined,
      lastCount: -5,
      lastEvaluatedAt: "private malformed evaluation timestamp",
      createdAt: "private malformed creation timestamp",
    };
    render(<SegmentDetailSlideover segment={incomplete} onClose={vi.fn()} />);
    await flush();

    expect(document.body.textContent).toContain("Record needs refresh");
    expect(document.body.textContent).toContain("No verified count");
    expect(document.body.textContent).toContain("Unverified timestamp");
    expect(document.body.textContent).not.toContain("private malformed");
    expect(document.body.textContent).toContain(
      "No predicate is included in this segment record.",
    );
    expect(document.body.textContent).toContain(
      "Edit and save a valid definition before recomputing.",
    );
    const recompute = button("Recompute now");
    expect(recompute.disabled).toBe(false);
    expect(recompute.getAttribute("aria-disabled")).toBe("true");
    act(() => recompute.click());
    expect(mocks.recompute).not.toHaveBeenCalled();
  });

  it("single-flights recompute, blocks dismissal and deletion accessibly, then reconciles an exact verified result", async () => {
    const pending = deferred<{
      data: { count: number; scheduled_at: string };
    }>();
    mocks.recompute.mockReturnValue(pending.promise);
    const onClose = vi.fn();
    const onDelete = vi.fn();
    const onRecomputed = vi.fn();
    render(
      <SegmentDetailSlideover
        segment={alpha}
        onClose={onClose}
        onDelete={onDelete}
        onRecomputed={onRecomputed}
      />,
    );
    await flush();

    const recompute = button("Recompute now");
    act(() => {
      recompute.click();
      recompute.click();
      button("Close segment details").click();
      button("Delete segment").click();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.recompute).toHaveBeenCalledTimes(1);
    expect(button("Recomputing…").disabled).toBe(false);
    expect(button("Recomputing…").getAttribute("aria-disabled")).toBe("true");
    expect(button("Recomputing…").getAttribute("aria-busy")).toBe("true");
    expect(button("Close segment details").disabled).toBe(false);
    expect(button("Close segment details").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(button("Delete segment").getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "prior cached count remains visible until a verified response replaces it",
    );

    act(() => {
      button("Close segment details").click();
      button("Delete segment").click();
    });
    dispatchEscape();
    expect(onClose).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({
        data: { count: 1300, scheduled_at: "2026-07-17T07:45:00.000Z" },
      });
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.recompute).toHaveBeenCalledWith(alpha.id);
    expect(document.body.textContent).toContain("Server-confirmed evaluation");
    expect(document.body.textContent).toContain("1,300 members");
    expect(document.body.textContent).toContain(
      "This refresh does not create or expand an evaluation snapshot.",
    );
    expect(onRecomputed).toHaveBeenCalledWith({
      ...alpha,
      lastCount: 1300,
      lastEvaluatedAt: "2026-07-17T07:45:00.000Z",
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Segment recompute confirmed.",
        detail: expect.stringContaining(alpha.id),
      }),
    );

    act(() => button("Delete segment").click());
    expect(onDelete).toHaveBeenCalledWith(alpha);
    act(() => button("Close segment details").click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("redacts backend detail, validates responses, and offers a truthful retry without replacing the cached count", async () => {
    mocks.recompute
      .mockResolvedValueOnce({
        error: {
          kind: "http",
          status: 500,
          code: "segment_recompute_failed",
          requestId: "request-safe-identifier-123",
          message: "private database host, SQL predicate, and tenant secret",
        },
      })
      .mockResolvedValueOnce({
        data: { count: -4, scheduled_at: "not-a-timestamp" },
      })
      .mockResolvedValueOnce({
        data: { count: 1310, scheduled_at: "2026-07-17T08:00:00.000Z" },
      });
    const onRecomputed = vi.fn();
    render(
      <SegmentDetailSlideover
        segment={alpha}
        onClose={vi.fn()}
        onRecomputed={onRecomputed}
      />,
    );
    await flush();

    act(() => button("Recompute now").click());
    await flush();
    expect(document.body.textContent).toContain(
      "The service could not complete the request.",
    );
    expect(document.body.textContent).toContain("request-safe-identifier-123");
    expect(document.body.textContent).not.toContain("private database host");
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "tenant secret",
    );
    expect(document.body.textContent).toContain("1,250 members");
    expect(onRecomputed).not.toHaveBeenCalled();

    act(() => button("Retry recompute").click());
    await flush();
    expect(document.body.textContent).toContain(
      "The server returned a recompute result that could not be verified.",
    );
    expect(document.body.textContent).toContain(
      "invalid_segment_recompute_result",
    );
    expect(onRecomputed).not.toHaveBeenCalled();

    act(() => button("Retry recompute").click());
    await flush();
    expect(mocks.recompute).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).toContain("1,310 members");
    expect(onRecomputed).toHaveBeenCalledTimes(1);
  });

  it("contains synchronous throws and promise rejections without exposing their messages", async () => {
    mocks.recompute
      .mockImplementationOnce(() => {
        throw new Error("sync private evaluator address");
      })
      .mockRejectedValueOnce(new Error("rejected private tenant detail"));
    render(<SegmentDetailSlideover segment={alpha} onClose={vi.fn()} />);
    await flush();

    act(() => button("Recompute now").click());
    await flush();
    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain("private evaluator");

    act(() => button("Retry recompute").click());
    await flush();
    expect(mocks.recompute).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("private tenant");
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "private tenant",
    );
  });

  it("ignores a superseded segment response and allows the newly selected segment to recompute after settlement", async () => {
    const older = deferred<{
      data: { count: number; scheduled_at: string };
    }>();
    mocks.recompute.mockReturnValueOnce(older.promise).mockResolvedValueOnce({
      data: { count: 90, scheduled_at: "2026-07-17T09:00:00.000Z" },
    });
    const onRecomputed = vi.fn();
    render(
      <SegmentDetailSlideover
        segment={alpha}
        onClose={vi.fn()}
        onRecomputed={onRecomputed}
      />,
    );
    await flush();
    act(() => button("Recompute now").click());

    render(
      <SegmentDetailSlideover
        segment={beta}
        onClose={vi.fn()}
        onRecomputed={onRecomputed}
      />,
    );
    await flush();
    expect(document.body.textContent).toContain(beta.id);
    expect(document.body.textContent).toContain("80 members");
    expect(document.body.textContent).toContain(
      `A recompute for segment ${alpha.id} is still finishing`,
    );

    await act(async () => {
      older.resolve({
        data: { count: 9999, scheduled_at: "2026-07-17T08:30:00.000Z" },
      });
      await older.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(document.body.textContent).toContain("80 members");
    expect(document.body.textContent).not.toContain("9,999 members");
    expect(onRecomputed).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    act(() => button("Recompute now").click());
    await flush();
    expect(mocks.recompute).toHaveBeenLastCalledWith(beta.id);
    expect(document.body.textContent).toContain("90 members");
    expect(onRecomputed).toHaveBeenCalledWith({
      ...beta,
      lastCount: 90,
      lastEvaluatedAt: "2026-07-17T09:00:00.000Z",
    });
  });

  it("keeps a server-confirmed result truthful when parent-row reconciliation throws", async () => {
    const onRecomputed = vi.fn(() => {
      throw new Error("private parent state detail");
    });
    render(
      <SegmentDetailSlideover
        segment={alpha}
        onClose={vi.fn()}
        onRecomputed={onRecomputed}
      />,
    );
    await flush();

    act(() => button("Recompute now").click());
    await flush();
    expect(document.body.textContent).toContain("Server-confirmed evaluation");
    expect(document.body.textContent).toContain(
      "parent segment row could not be reconciled",
    );
    expect(document.body.textContent).not.toContain("private parent");
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining(
          "Refresh the segment list to reconcile its row.",
        ),
      }),
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("does not update state, toast, or callbacks after an external unmount", async () => {
    const pending = deferred<{
      data: { count: number; scheduled_at: string };
    }>();
    mocks.recompute.mockReturnValue(pending.promise);
    const onRecomputed = vi.fn();
    render(
      <SegmentDetailSlideover
        segment={alpha}
        onClose={vi.fn()}
        onRecomputed={onRecomputed}
      />,
    );
    await flush();
    act(() => button("Recompute now").click());
    act(() => root?.unmount());
    root = null;

    await act(async () => {
      pending.resolve({
        data: { count: 1400, scheduled_at: "2026-07-17T10:00:00.000Z" },
      });
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRecomputed).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
