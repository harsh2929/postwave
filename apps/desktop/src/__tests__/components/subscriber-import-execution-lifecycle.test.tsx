// @vitest-environment happy-dom

import {
  act,
  type Dispatch,
  type SetStateAction,
  useEffect,
  useState,
} from "react";
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

import type {
  SubscriberImportDryRunResults,
  SubscriberImportPreview,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  confirm: vi.fn(),
  get: vi.fn(),
  progressUrl: vi.fn(),
  celebrate: vi.fn(),
  completed: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    cancelSubscriberImport: mocks.cancel,
    confirmSubscriberImport: mocks.confirm,
    getSubscriberImport: mocks.get,
    subscriberImportProgressUrlAuthed: mocks.progressUrl,
  },
}));

vi.mock("../../components/Celebrate", () => ({ celebrate: mocks.celebrate }));
vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

import {
  mergeSubscriberImportPoll,
  mergeSubscriberImportProgress,
  useImportExecution,
} from "../../components/subscribers/useImportExecution";

const ID = "018f07e2-7b1a-7000-8000-000000000001";
const OTHER_ID = "018f07e2-7b1a-7000-8000-000000000002";
const SOURCE = "a".repeat(64);

const basePreview: SubscriberImportPreview = {
  id: ID,
  status: "preview",
  rows_total: 2,
  rows_imported: 0,
  rows_skipped: 0,
  rows_failed: 0,
  processed_rows: 0,
  source_fingerprint: SOURCE,
  configuration_revision: 1,
};

const dryRunResults: SubscriberImportDryRunResults = {
  rows_total: 2,
  would_create: 2,
  would_update: 0,
  would_skip: 0,
  would_fail: 0,
  file_dupes: 0,
  rows: [
    { row_number: 1, outcome: "create" },
    { row_number: 2, outcome: "create" },
  ],
  detail_capped: false,
  validated_at: "2026-07-19T10:00:00Z",
  authoritative: true,
  preflight_fingerprint: "b".repeat(64),
  would_be_sendable: 0,
  would_remain_protected: 0,
  consent_contract_state: "none",
  state_fingerprint: "c".repeat(64),
  catalog_fingerprint: "d".repeat(64),
  expires_at: "2099-07-19T10:15:00Z",
};

interface Snapshot {
  busy: boolean;
  polling: boolean;
  error: string | null;
  preview: SubscriberImportPreview | null;
  preflight: SubscriberImportDryRunResults | null;
  cancelling: boolean;
  runPreflight: () => Promise<void>;
  queueImport: () => Promise<void>;
  requestCancel: () => Promise<void>;
  setPreview: Dispatch<SetStateAction<SubscriberImportPreview | null>>;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let snapshot: Snapshot | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Harness() {
  const [preview, setPreview] = useState<SubscriberImportPreview | null>(
    basePreview,
  );
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [preflight, setPreflight] =
    useState<SubscriberImportDryRunResults | null>(null);
  const execution = useImportExecution({
    preview,
    cancelling,
    onCompleted: mocks.completed,
    setBusy,
    setPolling,
    setError,
    setPreview,
    setCancelling,
    setPreflight,
  });

  useEffect(() => {
    snapshot = {
      busy,
      polling,
      error,
      preview,
      preflight,
      cancelling,
      runPreflight: execution.runPreflight,
      queueImport: execution.queueImport,
      requestCancel: execution.requestCancel,
      setPreview,
    };
  }, [
    busy,
    cancelling,
    error,
    execution.queueImport,
    execution.requestCancel,
    execution.runPreflight,
    polling,
    preflight,
    preview,
  ]);
  return null;
}

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  snapshot = null;
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.progressUrl.mockImplementation(() => new Promise<string>(() => {}));
  mocks.get.mockResolvedValue({
    error: { kind: "network", code: "network_error", message: "offline" },
  });
  localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("subscriber import confirmation settlement", () => {
  it("makes mandatory preflight same-tick single-flight and settles in finally", async () => {
    const pending = deferred<{ data: SubscriberImportPreview }>();
    mocks.confirm.mockReturnValue(pending.promise);
    render();

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = snapshot!.runPreflight();
      second = snapshot!.runPreflight();
    });
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.confirm).toHaveBeenCalledWith(ID, {
      dry_run: true,
      signal: expect.any(AbortSignal),
    });
    expect(snapshot?.busy).toBe(true);

    pending.resolve({
      data: {
        id: ID,
        status: "preview",
        dry_run: true,
        dry_run_results: dryRunResults,
      },
    });
    await act(async () => Promise.all([first, second]));

    expect(snapshot?.busy).toBe(false);
    expect(snapshot?.error).toBeNull();
    expect(snapshot?.preflight).toEqual(dryRunResults);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Exhaustive preflight verified 2 rows. Nothing was written.",
    );
  });

  it("redacts a thrown failure after one read-only recovery attempt", async () => {
    mocks.confirm.mockRejectedValue(new Error("secret database host"));
    render();

    await act(async () => snapshot!.runPreflight());

    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(snapshot?.busy).toBe(false);
    expect(snapshot?.error).toContain("exhaustive preflight could not finish");
    expect(snapshot?.error).toContain("Nothing was written");
    expect(snapshot?.error).not.toContain("secret database host");
  });

  it("recovers an authoritative preflight after a timeout without re-running it", async () => {
    mocks.confirm.mockResolvedValue({
      error: {
        kind: "timeout",
        code: "request_timeout",
        message: "upstream details",
      },
    });
    mocks.get.mockResolvedValue({
      data: {
        ...basePreview,
        classification_authoritative: true,
        preflight_required: false,
        preflight_fingerprint: dryRunResults.preflight_fingerprint,
        dry_run_results: dryRunResults,
      },
    });
    render();

    await act(async () => snapshot!.runPreflight());

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(snapshot?.preflight).toEqual(dryRunResults);
    expect(snapshot?.error).toBeNull();
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      expect.stringContaining("authoritative server result was recovered"),
    );
  });

  it("honors 429 retry guidance without an unsafe confirm retry or recovery GET", async () => {
    mocks.confirm.mockResolvedValue({
      error: {
        kind: "http",
        status: 429,
        code: "rate_limited",
        message: "sensitive service text",
        retryAfterSeconds: 4,
      },
    });
    render();

    await act(async () => snapshot!.runPreflight());

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(snapshot?.error).toContain("Wait about 4 seconds");
    expect(snapshot?.error).not.toContain("sensitive service text");
  });

  it("recovers a single queued job after a 5xx response", async () => {
    mocks.confirm.mockResolvedValue({
      error: { kind: "http", status: 503, code: "unavailable", message: "raw" },
    });
    mocks.get.mockResolvedValue({ data: { ...basePreview, status: "queued" } });
    render();

    await act(async () => snapshot!.queueImport());

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(snapshot?.preview?.status).toBe("queued");
    expect(snapshot?.polling).toBe(true);
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      expect.stringContaining("single server-side import was recovered"),
    );
  });

  it("ignores a late result after the workspace/import identity changes", async () => {
    const pending = deferred<{ data: SubscriberImportPreview }>();
    mocks.confirm.mockReturnValue(pending.promise);
    render();

    let confirmation!: Promise<void>;
    act(() => {
      confirmation = snapshot!.runPreflight();
      snapshot!.setPreview({ ...basePreview, id: OTHER_ID });
    });
    pending.resolve({
      data: { ...basePreview, dry_run_results: dryRunResults },
    });
    await act(async () => confirmation);

    expect(snapshot?.preview?.id).toBe(OTHER_ID);
    expect(snapshot?.preflight).toBeNull();
    expect(snapshot?.busy).toBe(false);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("serializes queue and cancellation in the same tick", async () => {
    const confirmation = deferred<{ data: SubscriberImportPreview }>();
    mocks.confirm.mockReturnValue(confirmation.promise);
    render();
    let queueOne!: Promise<void>;
    let queueTwo!: Promise<void>;
    act(() => {
      queueOne = snapshot!.queueImport();
      queueTwo = snapshot!.queueImport();
    });
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    confirmation.resolve({
      data: {
        id: ID,
        status: "queued",
        preflight_fingerprint: dryRunResults.preflight_fingerprint,
        classification_authoritative: true,
        consent_contract_state: "none",
      },
    });
    await act(async () => Promise.all([queueOne, queueTwo]));

    const cancellation = deferred<{
      data: { id: string; status: "cancelled"; cancel_requested: true };
    }>();
    mocks.cancel.mockReturnValue(cancellation.promise);
    let cancelOne!: Promise<void>;
    let cancelTwo!: Promise<void>;
    act(() => {
      cancelOne = snapshot!.requestCancel();
      cancelTwo = snapshot!.requestCancel();
    });
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    cancellation.resolve({
      data: { id: ID, status: "cancelled", cancel_requested: true },
    });
    await act(async () => Promise.all([cancelOne, cancelTwo]));

    expect(snapshot?.cancelling).toBe(false);
    expect(snapshot?.polling).toBe(false);
    expect(snapshot?.preview?.status).toBe("cancelled");
    expect(mocks.toastInfo).toHaveBeenCalledWith("Subscriber import cancelled.");
  });
});

describe("subscriber import progress integrity", () => {
  it("accepts only monotonic counters/status and rejects terminal regression", () => {
    const queued = { ...basePreview, status: "queued" as const };
    const running = mergeSubscriberImportProgress(queued, {
      status: "running",
      processed_rows: 1,
      total_rows: 2,
      rows_imported: 1,
      rows_skipped: 0,
      rows_failed: 0,
    });
    expect(running?.status).toBe("running");
    expect(
      mergeSubscriberImportProgress(running!, {
        status: "queued",
        processed_rows: 1,
        total_rows: 2,
        rows_imported: 1,
        rows_skipped: 0,
        rows_failed: 0,
      }),
    ).toBeNull();
    expect(
      mergeSubscriberImportProgress(running!, {
        status: "ready",
        processed_rows: 1,
        total_rows: 2,
        rows_imported: 1,
        rows_skipped: 0,
        rows_failed: 0,
      }),
    ).toBeNull();
    const ready = {
      ...running!,
      status: "ready" as const,
      processed_rows: 2,
      rows_imported: 2,
    };
    expect(mergeSubscriberImportPoll(ready, { ...ready, status: "running" })).toBeNull();
  });

  it("hands malformed SSE data to single-flight polling", async () => {
    vi.useFakeTimers();
    const instances: FakeEventSource[] = [];
    class FakeEventSource {
      readonly close = vi.fn();
      readonly listeners = new Map<string, (event: MessageEvent) => void>();
      onerror: (() => void) | null = null;

      constructor() {
        instances.push(this);
      }

      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
      }

      emit(type: string, data: string): void {
        this.listeners.get(type)?.({ data } as MessageEvent);
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    mocks.confirm.mockResolvedValue({ data: { ...basePreview, status: "queued" } });
    mocks.progressUrl.mockResolvedValue("https://api.example.test/progress");
    mocks.get.mockImplementation(() => new Promise(() => {}));
    render();

    await act(async () => {
      await snapshot!.queueImport();
      await Promise.resolve();
    });
    expect(instances).toHaveLength(1);
    act(() => instances[0].emit("progress", "{bad-json"));
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(instances[0].close).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("closes an owned SSE stream on unmount", async () => {
    const instances: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    class FakeEventSource {
      readonly close = vi.fn();
      readonly addEventListener = vi.fn();
      onerror: (() => void) | null = null;

      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    mocks.confirm.mockResolvedValue({ data: { ...basePreview, status: "queued" } });
    mocks.progressUrl.mockResolvedValue("https://api.example.test/progress");
    render();

    await act(async () => {
      await snapshot!.queueImport();
      await Promise.resolve();
    });
    expect(instances).toHaveLength(1);
    act(() => root?.unmount());
    root = null;
    expect(instances[0].close).toHaveBeenCalledTimes(1);
  });
});
