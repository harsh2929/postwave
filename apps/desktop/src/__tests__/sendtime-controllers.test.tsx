// @vitest-environment happy-dom

import { act, type ReactElement, StrictMode } from "react";
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
  getBestSendTime: vi.fn(),
  getSegmentBestSendTime: vi.fn(),
  getSegmentHeatmap: vi.fn(),
  getSubscriberOpenPattern: vi.fn(),
  getWorkspaceSetting: vi.fn(),
  listSegments: vi.fn(),
  putWorkspaceSetting: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api-client")>();
  return {
    ...actual,
    getSendTimeOptimization: mocks.getWorkspaceSetting,
    putSendTimeOptimization: mocks.putWorkspaceSetting,
    apiSendTimeAssets: {
      ...actual.apiSendTimeAssets,
      getBestSendTime: mocks.getBestSendTime,
      getSegmentBestSendTime: mocks.getSegmentBestSendTime,
      getSegmentHeatmap: mocks.getSegmentHeatmap,
      getSubscriberOpenPattern: mocks.getSubscriberOpenPattern,
    },
  };
});

vi.mock("../components/segments/segmentsClient", () => ({
  segmentsClient: {
    list: mocks.listSegments,
  },
}));

vi.mock("../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: vi.fn(),
    success: mocks.toastSuccess,
  },
}));

import {
  type AudienceSignalState,
  useSendTimeAudienceSignals,
  useSendTimeWorkspaceSetting,
  useSubscriberSendTimeLookup,
} from "../components/sendtime/useSendTimeControllers";
import { SendTimeWorkspacePolicy } from "../components/sendtime/SendTimeWorkspacePolicy";

type AudienceController = ReturnType<typeof useSendTimeAudienceSignals>;
type SubscriberController = ReturnType<typeof useSubscriberSendTimeLookup>;

const SEGMENT = {
  id: "segment-1",
  name: "Engaged readers",
  lastCount: 128,
};
const FIRST_UUID = "11111111-1111-4111-8111-111111111111";
const SECOND_UUID = "22222222-2222-4222-8222-222222222222";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let audience: AudienceController | null = null;
let subscriber: SubscriberController | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.listSegments.mockResolvedValue({ data: [SEGMENT] });
  mocks.getSegmentHeatmap.mockResolvedValue({ data: heatmap() });
  mocks.getSegmentBestSendTime.mockResolvedValue({
    data: {
      best_hour_utc: "09:00",
      confidence: 0.75,
      sample_size: 96,
      computed_at: "2026-07-26T10:00:00.000Z",
    },
  });
  mocks.getBestSendTime.mockResolvedValue({
    data: recommendation(FIRST_UUID, 33),
  });
  mocks.getSubscriberOpenPattern.mockResolvedValue({ data: pattern() });
  mocks.getWorkspaceSetting.mockResolvedValue({ data: { enabled: true } });
  mocks.putWorkspaceSetting.mockResolvedValue({ data: { enabled: false } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  audience = null;
  subscriber = null;
  document.body.replaceChildren();
});

describe("send-time audience controller", () => {
  it("does not request analysis until a valid saved segment is selected", async () => {
    render(<AudienceHarness identityKey="tenant-a" />);
    await settle();

    expect(audience?.catalog.kind).toBe("ready");
    expect(audience?.signal.kind).toBe("unscoped");
    expect(mocks.getSegmentHeatmap).not.toHaveBeenCalled();
    expect(mocks.getSegmentBestSendTime).not.toHaveBeenCalled();

    act(() => audience?.setSelectedSegmentId(SEGMENT.id));
    await settle();

    expect(mocks.getSegmentHeatmap).toHaveBeenCalledTimes(1);
    expect(mocks.getSegmentHeatmap).toHaveBeenCalledWith({
      segmentId: SEGMENT.id,
    });
    expect(mocks.getSegmentBestSendTime).toHaveBeenCalledWith({
      segmentId: SEGMENT.id,
    });
    expect(audience?.signal.kind).toBe("ready");
  });

  it("restores only a segment that exists in the current catalog", async () => {
    localStorage.setItem("pw.sendtime.segment.tenant-a", SEGMENT.id);

    render(<AudienceHarness identityKey="tenant-a" />);
    await settle();

    expect(audience?.selectedSegmentId).toBe(SEGMENT.id);
    expect(audience?.selectedSegment?.name).toBe(SEGMENT.name);
    expect(mocks.getSegmentHeatmap).toHaveBeenCalledWith({
      segmentId: SEGMENT.id,
    });

    unmount();
    vi.clearAllMocks();
    mocks.listSegments.mockResolvedValue({ data: [SEGMENT] });
    localStorage.setItem("pw.sendtime.segment.tenant-b", "deleted-segment");

    render(<AudienceHarness identityKey="tenant-b" />);
    await settle();

    expect(audience?.selectedSegmentId).toBe("");
    expect(audience?.signal.kind).toBe("unscoped");
    expect(mocks.getSegmentHeatmap).not.toHaveBeenCalled();
    expect(mocks.getSegmentBestSendTime).not.toHaveBeenCalled();
  });

  it.each([
    [404, "insufficient", "This segment does not yet have enough members"],
    [503, "error", "[temporarily_unavailable] model offline"],
  ] as const)(
    "keeps a %s response distinct as %s",
    async (status, expectedKind, expectedMessage) => {
      mocks.getSegmentHeatmap.mockResolvedValue({
        error: {
          status,
          code: status === 503 ? "temporarily_unavailable" : "not_found",
          message: status === 503 ? "model offline" : "not enough data",
        },
      });

      render(<AudienceHarness identityKey="tenant-a" />);
      await settle();
      act(() => audience?.setSelectedSegmentId(SEGMENT.id));
      await settle();

      expect(audience?.signal.kind).toBe(expectedKind);
      expect(signalMessage(audience?.signal)).toContain(expectedMessage);
    },
  );

  it("keeps an empty catalog distinct from a catalog request failure", async () => {
    mocks.listSegments.mockResolvedValueOnce({ data: [] });
    render(<AudienceHarness identityKey="tenant-a" />);
    await settle();

    expect(audience?.catalog).toEqual({ kind: "ready", segments: [] });
    expect(audience?.signal.kind).toBe("unscoped");

    unmount();
    mocks.listSegments.mockResolvedValueOnce({
      error: {
        status: 503,
        code: "segments_unavailable",
        message: "catalog offline",
      },
    });
    render(<AudienceHarness identityKey="tenant-a" />);
    await settle();

    expect(audience?.catalog).toEqual({
      kind: "error",
      message: "[segments_unavailable] catalog offline",
    });
  });
});

describe("send-time subscriber controller", () => {
  it("rejects malformed subscriber identifiers without making a request", async () => {
    render(<SubscriberHarness identityKey="tenant-a" />);
    await settle();
    act(() => subscriber?.setLookupId("customer@example.com"));
    await settle();
    await act(async () => subscriber?.submit());

    expect(subscriber?.inputError).toContain("full subscriber UUID");
    expect(subscriber?.state.kind).toBe("idle");
    expect(mocks.getBestSendTime).not.toHaveBeenCalled();
    expect(mocks.getSubscriberOpenPattern).not.toHaveBeenCalled();
  });

  it("treats the backend's -1 sentinel as cold instead of a recommendation", async () => {
    mocks.getBestSendTime.mockResolvedValue({
      data: recommendation(FIRST_UUID, -1),
    });

    render(<SubscriberHarness identityKey="tenant-a" />);
    await settle();
    await inspect(FIRST_UUID);

    expect(subscriber?.state).toEqual({
      kind: "cold",
      lookupKey: FIRST_UUID,
    });
  });

  it("ignores a previous lookup that completes after the latest lookup", async () => {
    const firstBest = deferred<unknown>();
    const firstPattern = deferred<unknown>();
    const secondBest = deferred<unknown>();
    const secondPattern = deferred<unknown>();
    mocks.getBestSendTime
      .mockImplementationOnce(() => firstBest.promise)
      .mockImplementationOnce(() => secondBest.promise);
    mocks.getSubscriberOpenPattern
      .mockImplementationOnce(() => firstPattern.promise)
      .mockImplementationOnce(() => secondPattern.promise);

    render(<SubscriberHarness identityKey="tenant-a" />);
    await settle();
    const firstSubmit = await startInspect(FIRST_UUID);
    const secondSubmit = await startInspect(SECOND_UUID);

    await act(async () => {
      secondBest.resolve({ data: recommendation(SECOND_UUID, 47) });
      secondPattern.resolve({ data: pattern() });
      await secondSubmit.completion;
    });
    expectReadyLookup(SECOND_UUID, 47);

    await act(async () => {
      firstBest.resolve({ data: recommendation(FIRST_UUID, 12) });
      firstPattern.resolve({ data: pattern() });
      await firstSubmit.completion;
    });
    expectReadyLookup(SECOND_UUID, 47);
  });

  it("clears a rendered result as soon as the identifier is edited", async () => {
    render(<SubscriberHarness identityKey="tenant-a" />);
    await settle();
    await inspect(FIRST_UUID);
    expect(subscriber?.state.kind).toBe("ready");

    act(() => subscriber?.setLookupId(`${FIRST_UUID.slice(0, -1)}0`));
    await settle();

    expect(subscriber?.state.kind).toBe("idle");
    expect(subscriber?.inputError).toBeNull();
  });

  it("clears the identifier and confidential result when identity changes", async () => {
    render(<SubscriberHarness identityKey="tenant-a" />);
    await settle();
    await inspect(FIRST_UUID);
    expect(subscriber?.state.kind).toBe("ready");

    rerender(<SubscriberHarness identityKey="tenant-b" />);
    await settle();

    expect(subscriber?.lookupId).toBe("");
    expect(subscriber?.state).toEqual({ kind: "idle" });
  });
});

describe("send-time workspace policy presentation", () => {
  it("presents policy as protected read-only state to a viewer", async () => {
    render(<PolicyHarness canAdmin={false} identityKey="tenant-a" />);
    await settle();

    expect(document.body.textContent).toContain(
      "Read only · an admin controls this setting",
    );
    expect(document.body.textContent).toContain("Protected");
    expect(document.querySelector("[role='switch']")).toBeNull();
    expect(mocks.putWorkspaceSetting).not.toHaveBeenCalled();
  });

  it("lets an admin operate the server-owned switch and reflects confirmation", async () => {
    render(<PolicyHarness canAdmin identityKey="tenant-a" />);
    await settle();

    const toggle = document.querySelector<HTMLButtonElement>("[role='switch']");
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-checked")).toBe("true");

    await act(async () => toggle?.click());
    await settle();

    expect(mocks.putWorkspaceSetting).toHaveBeenCalledWith({ enabled: false });
    expect(
      document
        .querySelector<HTMLButtonElement>("[role='switch']")
        ?.getAttribute("aria-checked"),
    ).toBe("false");
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Personalized timing is off by default for new campaigns.",
    );
  });
});

describe("send-time controller lifecycle", () => {
  it("keeps every controller live through the desktop root's StrictMode effect replay", async () => {
    render(
      <StrictMode>
        <AudienceHarness identityKey="tenant-a" />
        <SubscriberHarness identityKey="tenant-a" />
        <PolicyHarness canAdmin identityKey="tenant-a" />
      </StrictMode>,
    );
    await settle();

    expect(audience?.catalog.kind).toBe("ready");
    expect(document.querySelector("[role='switch']")).not.toBeNull();

    await inspect(FIRST_UUID);
    expectReadyLookup(FIRST_UUID, 33);
  });
});

function AudienceHarness({
  identityKey,
}: {
  identityKey: string;
}): ReactElement | null {
  audience = useSendTimeAudienceSignals(identityKey);
  return null;
}

function SubscriberHarness({
  identityKey,
}: {
  identityKey: string;
}): ReactElement | null {
  subscriber = useSubscriberSendTimeLookup(identityKey);
  return null;
}

function PolicyHarness({
  canAdmin,
  identityKey,
}: {
  canAdmin: boolean;
  identityKey: string;
}): ReactElement {
  const controller = useSendTimeWorkspaceSetting({ canAdmin, identityKey });
  return (
    <SendTimeWorkspacePolicy canAdmin={canAdmin} controller={controller} />
  );
}

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

function rerender(element: ReactElement): void {
  act(() => root?.render(element));
}

function unmount(): void {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  audience = null;
  subscriber = null;
}

async function settle(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(
      async () =>
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, 0);
        }),
    );
  }
}

async function inspect(id: string): Promise<void> {
  const request = await startInspect(id);
  await act(async () => request.completion);
  await settle();
}

async function startInspect(
  id: string,
): Promise<{ completion: Promise<void> }> {
  act(() => subscriber?.setLookupId(id));
  await settle();
  let completion: Promise<void> | undefined;
  act(() => {
    completion = subscriber?.submit();
  });
  await settle();
  if (!completion) throw new Error("Subscriber lookup did not start");
  return { completion };
}

function expectReadyLookup(id: string, bestHour: number): void {
  expect(subscriber?.state.kind).toBe("ready");
  if (subscriber?.state.kind !== "ready") return;
  expect(subscriber.state.lookupKey).toBe(id);
  expect(subscriber.state.recommendation.best_hour_utc).toBe(bestHour);
}

function signalMessage(state: AudienceSignalState | undefined): string {
  return state && "message" in state ? state.message : "";
}

function recommendation(id: string, bestHour: number) {
  return {
    email: `${id.slice(0, 8)}@example.com`,
    best_hour_utc: bestHour,
    computed_at: "2026-07-26T10:00:00.000Z",
    sample_size: 12,
  };
}

function heatmap() {
  return {
    segment_id: SEGMENT.id,
    grid: Array.from({ length: 7 }, () => Array(24).fill(0)),
    best_dow: 1,
    best_hour: 9,
    subscribers_with_data: 96,
    computed_at: "2026-07-26T10:00:00.000Z",
  };
}

function pattern() {
  return {
    grid: Array.from({ length: 7 }, () => Array(24).fill(0)),
    best_dow: 1,
    best_hour: 9,
    sample_size: 12,
    bimodal: false,
    computed_at: "2026-07-26T10:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
