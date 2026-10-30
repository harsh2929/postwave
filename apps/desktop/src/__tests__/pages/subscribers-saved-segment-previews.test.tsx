// @vitest-environment happy-dom

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
  listSavedSegments: vi.fn(),
  previewSavedSegmentDetail: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  listSavedSegments: mocks.listSavedSegments,
  previewSavedSegmentDetail: mocks.previewSavedSegmentDetail,
}));

import type { SavedSegment, SavedSegmentPreview } from "../../lib/api-client";
import {
  SAVED_SEGMENT_PREVIEW_STALE_MS,
  savedCountIsStale,
  validSavedSegmentPreview,
} from "../../components/subscribers/saved-segment-preview-state";
import {
  type SubscribersSavedSegmentPreviews,
  useSavedSegmentPreviews,
} from "../../pages/subscribers/useSavedSegmentPreviews";
import {
  type SavedSegmentsLibrary,
  useSavedSegmentsLibrary,
} from "../../pages/subscribers/useSavedSegmentsLibrary";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function segment(
  id: string,
  overrides: Partial<SavedSegment> = {},
): SavedSegment {
  return {
    id,
    tenant_id: "tenant-1",
    name: `Segment ${id}`,
    description: "",
    predicate_json: {},
    is_pinned: false,
    visibility_scope: "personal",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function preview(id: string): SavedSegmentPreview {
  return {
    id,
    count: 12,
    workspace_total: 100,
    workspace_percentage: 12,
    generated_at: "2026-07-18T00:00:00.000Z",
  };
}

describe("saved preview evidence validation", () => {
  it("rejects fractional aggregates and treats materially future counts as stale", () => {
    expect(validSavedSegmentPreview({ ...preview("one"), count: 1.5 })).toBe(
      false,
    );
    const now = Date.parse("2026-07-18T00:00:00.000Z");
    expect(
      savedCountIsStale(
        new Date(now + SAVED_SEGMENT_PREVIEW_STALE_MS + 1).toISOString(),
        now,
      ),
    ).toBe(true);
  });
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: SubscribersSavedSegmentPreviews | null = null;
let latestLibrary: SavedSegmentsLibrary | null = null;

function Harness({
  open,
  identity,
  segments,
}: {
  open: boolean;
  identity: string | null;
  segments: SavedSegment[];
}): ReactElement {
  latest = useSavedSegmentPreviews(open, segments, identity);
  return <div data-count={Object.keys(latest.previews).length} />;
}

function LibraryHarness({
  identity,
}: {
  identity: string | null;
}): ReactElement {
  latestLibrary = useSavedSegmentsLibrary(identity);
  return <div data-count={latestLibrary.segments.length} />;
}

async function renderHarness(props: {
  open: boolean;
  identity: string | null;
  segments: SavedSegment[];
}): Promise<void> {
  await act(async () => {
    root?.render(<Harness {...props} />);
  });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => Promise.resolve());
  }
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
  latestLibrary = null;
  mocks.listSavedSegments.mockResolvedValue({ data: { items: [] } });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
  latestLibrary = null;
});

describe("saved-segment preview ownership", () => {
  it("does not fan out on open and never owns more than two preview requests", async () => {
    const requests = [
      deferred<{ data: SavedSegmentPreview }>(),
      deferred<{ data: SavedSegmentPreview }>(),
      deferred<{ data: SavedSegmentPreview }>(),
    ];
    mocks.previewSavedSegmentDetail.mockImplementation(
      (_id: string, options: { signal: AbortSignal }) => {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return requests[mocks.previewSavedSegmentDetail.mock.calls.length - 1]
          ?.promise;
      },
    );
    const segments = [segment("one"), segment("two"), segment("three")];
    await renderHarness({ open: true, identity: "workspace:a", segments });

    expect(mocks.previewSavedSegmentDetail).not.toHaveBeenCalled();
    act(() => {
      latest?.requestPreview("one");
      latest?.requestPreview("two");
      latest?.requestPreview("three");
    });
    expect(mocks.previewSavedSegmentDetail).toHaveBeenCalledTimes(2);

    requests[0]?.resolve({ data: preview("one") });
    await flush();
    expect(mocks.previewSavedSegmentDetail).toHaveBeenCalledTimes(3);
    expect(latest?.previews.one?.kind).toBe("ok");

    requests[1]?.resolve({ data: preview("two") });
    requests[2]?.resolve({ data: preview("three") });
    await flush();
    expect(
      Object.values(latest?.previews ?? {}).map(({ kind }) => kind),
    ).toEqual(["ok", "ok", "ok"]);
  });

  it("aborts requests on close or identity change and ignores their late results", async () => {
    const oldRequest = deferred<{ data: SavedSegmentPreview }>();
    const nextRequest = deferred<{ data: SavedSegmentPreview }>();
    mocks.previewSavedSegmentDetail
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(nextRequest.promise);
    const segments = [segment("one")];
    await renderHarness({ open: true, identity: "workspace:a", segments });
    act(() => latest?.requestPreview("one"));
    const oldSignal = mocks.previewSavedSegmentDetail.mock.calls[0]?.[1]
      .signal as AbortSignal;

    await renderHarness({ open: false, identity: "workspace:b", segments });
    expect(oldSignal.aborted).toBe(true);
    oldRequest.resolve({ data: preview("one") });
    await flush();
    expect(latest?.previews.one).toBeUndefined();

    await renderHarness({ open: true, identity: "workspace:b", segments });
    act(() => latest?.requestPreview("one"));
    expect(mocks.previewSavedSegmentDetail).toHaveBeenCalledTimes(2);
    nextRequest.resolve({ data: preview("one") });
    await flush();
    expect(latest?.previews.one?.kind).toBe("ok");
  });

  it("fails closed on malformed aggregates, supports explicit retry, and invalidates counts", async () => {
    mocks.previewSavedSegmentDetail
      .mockResolvedValueOnce({
        data: { ...preview("one"), generated_at: "not-a-date" },
      })
      .mockResolvedValueOnce({ data: preview("one") });
    const segments = [segment("one")];
    await renderHarness({ open: true, identity: "workspace:a", segments });

    act(() => latest?.requestPreview("one"));
    await flush();
    expect(latest?.previews.one?.kind).toBe("err");
    if (latest?.previews.one?.kind === "err") {
      expect(latest.previews.one.failure.message).not.toContain("not-a-date");
    }

    act(() => latest?.requestPreview("one", true));
    await flush();
    expect(mocks.previewSavedSegmentDetail).toHaveBeenCalledTimes(2);
    expect(latest?.previews.one).toMatchObject({
      kind: "ok",
      invalidated: false,
    });

    act(() => latest?.invalidatePreviewCounts());
    expect(latest?.previews.one).toMatchObject({
      kind: "ok",
      invalidated: true,
    });
  });
});

describe("saved-segment library truth", () => {
  it("keeps fetch failures distinct from empty data and supports an explicit retry", async () => {
    const retry = deferred<{
      data: { items: SavedSegment[]; total_items: number; max_items: number };
    }>();
    mocks.listSavedSegments
      .mockResolvedValueOnce({
        error: { kind: "http", status: 503, message: "Unavailable" },
      })
      .mockReturnValueOnce(retry.promise);
    await act(async () => {
      root?.render(<LibraryHarness identity="workspace:a" />);
    });
    await flush();
    expect(latestLibrary?.segments).toEqual([]);
    expect(latestLibrary?.error).toBe(
      "The service could not complete the request.",
    );

    let firstRetry: Promise<void> | undefined;
    act(() => {
      firstRetry = latestLibrary?.load();
      void latestLibrary?.load();
    });
    expect(mocks.listSavedSegments).toHaveBeenCalledTimes(2);
    retry.resolve({
      data: { items: [segment("one")], total_items: 1, max_items: 200 },
    });
    await act(async () => firstRetry);
    expect(latestLibrary?.error).toBeNull();
    expect(latestLibrary?.segments.map(({ id }) => id)).toEqual(["one"]);
  });

  it("marks denormalized list counts stale after a locally known mutation", async () => {
    mocks.listSavedSegments.mockResolvedValue({
      data: {
        items: [
          segment("one", {
            last_count: 12,
            last_evaluated_at: "2026-07-18T00:00:00.000Z",
          }),
        ],
        total_items: 1,
        max_items: 200,
      },
    });
    await act(async () => {
      root?.render(<LibraryHarness identity="workspace:a" />);
    });
    await flush();

    act(() => latestLibrary?.invalidatePreviewCounts());
    expect(latestLibrary?.segments[0]?.last_count).toBe(12);
    expect(latestLibrary?.segments[0]?.last_evaluated_at).toBe(
      "1970-01-01T00:00:00.000Z",
    );
  });
});
