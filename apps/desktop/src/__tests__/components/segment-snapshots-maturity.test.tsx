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

const mocks = vi.hoisted(() => ({
  createSnapshot: vi.fn(),
  listSnapshotMembers: vi.fn(),
  listSnapshots: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../components/segments/segmentsClient", () => ({
  segmentsClient: {
    createSnapshot: mocks.createSnapshot,
    listSnapshotMembers: mocks.listSnapshotMembers,
    listSnapshots: mocks.listSnapshots,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { SegmentSnapshotsSection } from "../../components/segments/SegmentSnapshotsSection";

const CREATED_AT = "2026-07-16T08:30:00.000Z";
const EVALUATED_AT = "2026-07-16T08:29:58.000Z";

function snapshot(
  segmentId = "segment-alpha",
  id = "snapshot-complete-identifier-001",
) {
  return {
    id,
    tenant_id: "tenant-complete-identifier-001",
    segment_id: segmentId,
    query_ast: { op: "and", children: [] },
    count: 120,
    sample_size: 75,
    evaluator_version: "segment-evaluator-v7.4.1",
    evaluated_at: EVALUATED_AT,
    created_at: CREATED_AT,
  };
}

function membersPage(page = 1) {
  return {
    items:
      page === 1
        ? [
            {
              email: "complete.member@example.test",
              subscriber_id: "subscriber-complete-identifier-001",
            },
          ]
        : [
            {
              email: "second.page@example.test",
              subscriber_id: "subscriber-second-page-identifier-051",
            },
          ],
    page,
    per_page: 50,
    total: 120,
    sample_size: 75,
    sample_is_complete: false,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSnapshots.mockResolvedValue({
    data: { items: [snapshot()] },
  });
  mocks.createSnapshot.mockResolvedValue({ data: snapshot() });
  mocks.listSnapshotMembers.mockImplementation(
    (_snapshotId: string, options: { page: number }) =>
      Promise.resolve({ data: membersPage(options.page) }),
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
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
  ).find((candidate) => candidate.textContent?.trim() === label);
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

describe("SegmentSnapshotsSection interaction maturity", () => {
  it("states the bounded-record truth, exposes complete metadata, and is accessible", async () => {
    render(
      <SegmentSnapshotsSection segmentId="segment-alpha" canMutate={false} />,
    );
    await flush();

    expect(document.body.textContent).toContain(
      "not a complete immutable recipient list",
    );
    expect(document.body.textContent).toContain(
      "snapshot-complete-identifier-001",
    );
    expect(document.body.textContent).toContain("segment-evaluator-v7.4.1");
    expect(document.body.textContent).toContain(
      "75 of 120 evaluated members were cached",
    );
    expect(document.body.textContent).not.toContain("exact same set");
    expect(container?.querySelector("[title]")).toBeNull();

    const record = button("Record snapshot");
    expect(record.disabled).toBe(false);
    expect(record.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "editor or administrator role is required",
    );

    act(() => button("View cached members").click());
    await flush();
    expect(document.body.textContent).toContain("complete.member@example.test");
    expect(document.body.textContent).toContain(
      "subscriber-complete-identifier-001",
    );
    expect(document.body.textContent).toContain(
      "remaining membership rows were not retained",
    );
    expect(button("Previous page").disabled).toBe(false);
    expect(button("Previous page").getAttribute("aria-disabled")).toBe("true");
    expect(button("Next page").getAttribute("aria-disabled")).toBeNull();

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("contains list failures, provides safe recovery, and never renders raw backend detail", async () => {
    mocks.listSnapshots
      .mockRejectedValueOnce(
        new Error("private database host and subscriber predicate"),
      )
      .mockResolvedValueOnce({ data: { items: [snapshot()] } });

    render(<SegmentSnapshotsSection segmentId="segment-alpha" canMutate />);
    await flush();
    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain("private database host");

    act(() => button("Retry").click());
    await flush();
    expect(mocks.listSnapshots).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(
      "snapshot-complete-identifier-001",
    );
  });

  it("single-flights recording, keeps its busy action focusable, and confirms exact scope", async () => {
    const pending = deferred<{ data: ReturnType<typeof snapshot> }>();
    mocks.createSnapshot.mockReturnValue(pending.promise);
    render(<SegmentSnapshotsSection segmentId="segment-alpha" canMutate />);
    await flush();

    act(() => {
      button("Record snapshot").click();
      button("Record snapshot").click();
    });
    expect(mocks.createSnapshot).toHaveBeenCalledTimes(1);
    expect(button("Recording…").disabled).toBe(false);
    expect(button("Recording…").getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "current predicate is being evaluated",
    );

    await act(async () => {
      pending.resolve({ data: snapshot() });
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.toastSuccess).toHaveBeenCalledWith({
      message: "Segment evaluation snapshot recorded.",
      detail:
        "Recorded snapshot snapshot-complete-identifier-001: 120 matched, 75 cached for browsing. This is an evaluation record, not an immutable recipient list.",
    });
    expect(document.body.textContent).toContain(
      "120 matched, 75 cached for browsing",
    );
    expect(mocks.listSnapshots).toHaveBeenCalledTimes(2);
  });

  it("ignores superseded segment responses instead of showing cross-segment records", async () => {
    const alpha = deferred<{
      data: { items: ReturnType<typeof snapshot>[] };
    }>();
    const beta = deferred<{ data: { items: ReturnType<typeof snapshot>[] } }>();
    mocks.listSnapshots.mockImplementation((segmentId: string) =>
      segmentId === "segment-alpha" ? alpha.promise : beta.promise,
    );

    render(<SegmentSnapshotsSection segmentId="segment-alpha" canMutate />);
    await flush();
    act(() =>
      root?.render(
        <SegmentSnapshotsSection segmentId="segment-beta" canMutate />,
      ),
    );
    await flush();

    await act(async () => {
      beta.resolve({
        data: {
          items: [snapshot("segment-beta", "snapshot-beta-complete-id")],
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("snapshot-beta-complete-id");

    await act(async () => {
      alpha.resolve({
        data: {
          items: [snapshot("segment-alpha", "snapshot-alpha-stale-id")],
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("snapshot-beta-complete-id");
    expect(document.body.textContent).not.toContain("snapshot-alpha-stale-id");
  });

  it("keeps member paging bounded and hides stale rows while the next page verifies", async () => {
    const secondPage = deferred<{ data: ReturnType<typeof membersPage> }>();
    mocks.listSnapshotMembers.mockImplementation(
      (_snapshotId: string, options: { page: number }) =>
        options.page === 1
          ? Promise.resolve({ data: membersPage(1) })
          : secondPage.promise,
    );
    render(<SegmentSnapshotsSection segmentId="segment-alpha" canMutate />);
    await flush();
    act(() => button("View cached members").click());
    await flush();

    act(() => {
      button("Next page").click();
      button("Next page").click();
    });
    await flush();
    expect(mocks.listSnapshotMembers).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(
      "Verifying cached members for page 2",
    );
    expect(document.body.textContent).not.toContain(
      "complete.member@example.test",
    );

    await act(async () => {
      secondPage.resolve({ data: membersPage(2) });
      await secondPage.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("second.page@example.test");
    expect(document.body.textContent).toContain("Page 2 of 2");
    expect(button("Next page").disabled).toBe(false);
    expect(button("Next page").getAttribute("aria-disabled")).toBe("true");
  });
});
