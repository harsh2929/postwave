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

import type { HistoryEntry } from "../../components/playground/PlaygroundHistory";
import type * as PlaygroundHeadersModule from "../../components/playground/PlaygroundHeaders";
import openapi from "../../../../../packages/openapi/openapi.json";
import {
  normalizePlaygroundCatalog,
  type NormalizedPlaygroundOperation,
} from "../../pages/api-playground-openapi";
import { executionPolicyFor } from "../../pages/api-playground-policy";
import {
  PLAYGROUND_HEADER_VALUE_MAX_BYTES,
  PLAYGROUND_PATH_VALUE_MAX_BYTES,
  PLAYGROUND_QUERY_MAX_BYTES,
  PLAYGROUND_REQUEST_BODY_MAX_BYTES,
} from "../../pages/api-playground-request";
import type { PlaygroundTransportResponse } from "../../pages/api-playground-transport";
import {
  type PlaygroundWorkbenchController,
  playgroundRequiresVerifiedStateBeforeRetry,
  usePlaygroundWorkbenchController,
} from "../../pages/api-playground-workbench-state";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  generateIdempotencyKey: vi.fn(),
  recordHistory: vi.fn(),
  registerLifecycleGuard: vi.fn(() => vi.fn()),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("../../pages/api-playground-transport", () => ({
  executePlaygroundRequest: mocks.execute,
}));

vi.mock("../../components/playground/PlaygroundHistory", () => ({
  recordHistoryEntry: mocks.recordHistory,
}));

vi.mock("../../components/playground/PlaygroundHeaders", async () => {
  const actual = await vi.importActual<typeof PlaygroundHeadersModule>(
    "../../components/playground/PlaygroundHeaders",
  );
  return {
    ...actual,
    generateIdempotencyKey: mocks.generateIdempotencyKey,
  };
});

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
  },
}));

vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: mocks.registerLifecycleGuard,
}));

const API_URL = "https://api.postwave.test";
const HISTORY_SCOPE = "api.postwave.test\u0000workspace-1\u0000principal-1";
const LIVE_REVIEWED_OPERATIONS = new Map(
  normalizePlaygroundCatalog(openapi).operations.map((item) => [
    `${item.method.toUpperCase()} ${item.path}`,
    item,
  ]),
);

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: PlaygroundWorkbenchController | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  let generated = 0;
  mocks.execute.mockReset().mockResolvedValue(response());
  mocks.generateIdempotencyKey
    .mockReset()
    .mockImplementation(() => `idem-${++generated}`);
  mocks.recordHistory.mockReset().mockResolvedValue(undefined);
  mocks.registerLifecycleGuard.mockClear();
  mocks.toastError.mockReset();
  mocks.toastInfo.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  latest = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function operation(
  overrides: Partial<NormalizedPlaygroundOperation> = {},
): NormalizedPlaygroundOperation {
  return {
    ...structuredClone(LIVE_REVIEWED_OPERATIONS.get("GET /api/v1/tags")!),
    ...overrides,
  };
}

function editableTagOperation(
  overrides: Partial<NormalizedPlaygroundOperation> = {},
): NormalizedPlaygroundOperation {
  return {
    ...structuredClone(
      LIVE_REVIEWED_OPERATIONS.get("PATCH /api/v1/tags/{id}")!,
    ),
    ...overrides,
  };
}

function response(
  overrides: Partial<PlaygroundTransportResponse> = {},
): PlaygroundTransportResponse {
  return {
    status: 200,
    statusText: "OK",
    body: '{"ok":true}',
    headers: { "content-type": "application/json" },
    contentType: "application/json",
    previewBytes: 11,
    truncated: false,
    durationMs: 18,
    outcome: "http",
    ambiguous: false,
    requestId: "request-1",
    ...overrides,
  };
}

function Harness({
  operations,
  role = "admin",
}: {
  operations: NormalizedPlaygroundOperation[];
  role?: string | null;
}): ReactElement {
  latest = usePlaygroundWorkbenchController({
    operations,
    apiURL: API_URL,
    historyScope: HISTORY_SCOPE,
    effectiveRole: role,
  });
  return (
    <div>
      <span data-selected={latest.selectedKey} />
      {latest.sending ? (
        <button type="button" onClick={latest.cancel}>
          Cancel request
        </button>
      ) : null}
    </div>
  );
}

function renderHarness(
  operations: NormalizedPlaygroundOperation[],
  role: string | null = "admin",
): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness operations={operations} role={role} />));
}

function controller(): PlaygroundWorkbenchController {
  if (!latest) throw new Error("Controller was not rendered");
  return latest;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function prepareEditableDraft(): Promise<void> {
  act(() => {
    controller().updateDraft({ body: '{"name":"Example tag"}' });
    controller().updateDraftMap("path", "id", "tag-1");
    controller().updateDraftMap("headers", "If-Match", '"tag-1-v1"');
  });
  await flush();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function historyEntry(target: NormalizedPlaygroundOperation): HistoryEntry {
  return {
    id: "history-1",
    ts: Date.now(),
    method: target.method.toUpperCase() as HistoryEntry["method"],
    pathTemplate: target.path,
    status: 200,
    durationMs: 12,
    outcome: "http",
    ambiguous: false,
    body: "",
    bodyOmitted: true,
  };
}

describe("API Playground workbench controller", () => {
  it("fails closed while effective role authority is unresolved", async () => {
    renderHarness([operation()], null);

    await act(async () => controller().requestSend());
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "viewer authority required" }),
    );
  });

  it("persists untouched idempotency and edited drafts across selection", async () => {
    const editable = editableTagOperation();
    const read = operation({
      path: "/api/v1/campaigns",
      operationId: "listCampaigns",
      summary: "List campaigns",
    });
    renderHarness([editable, read]);

    const originalKey = controller().draft.idempotencyKey;
    expect(originalKey).toBe("idem-1");
    act(() => controller().select("GET /api/v1/campaigns"));
    await flush();
    act(() => controller().select("PATCH /api/v1/tags/{id}"));
    await flush();
    expect(controller().draft.idempotencyKey).toBe(originalKey);

    act(() => controller().updateDraft({ body: '{"name":"Private"}' }));
    await flush();
    act(() => controller().select("GET /api/v1/campaigns"));
    await flush();
    act(() => controller().select("PATCH /api/v1/tags/{id}"));
    await flush();
    expect(controller().draft.body).toBe('{"name":"Private"}');
    expect(controller().draft.idempotencyKey).toBe(originalKey);
  });

  it("omits oversized catalog examples instead of creating false truncated values", () => {
    const oversized = editableTagOperation({
      parameters: [
        {
          name: "id",
          location: "path",
          required: true,
          example: "p".repeat(PLAYGROUND_PATH_VALUE_MAX_BYTES + 1),
        },
        {
          name: "search",
          location: "query",
          required: false,
          example: "q".repeat(PLAYGROUND_QUERY_MAX_BYTES + 1),
        },
        {
          name: "If-Match",
          location: "header",
          required: true,
          example: "h".repeat(PLAYGROUND_HEADER_VALUE_MAX_BYTES + 1),
        },
      ],
      requestBody: {
        required: true,
        mediaTypes: ["application/json"],
        selectedMediaType: "application/json",
        example: { value: "b".repeat(PLAYGROUND_REQUEST_BODY_MAX_BYTES) },
        exampleSource: "explicit",
      },
    });

    renderHarness([oversized]);

    expect(controller().draft).toMatchObject({
      path: {},
      query: {},
      headers: {},
      body: "",
      touched: false,
    });
  });

  it("keeps one read in flight and leaves a visible working cancel", async () => {
    const pending = deferred<PlaygroundTransportResponse>();
    mocks.execute.mockReturnValueOnce(pending.promise);
    renderHarness([
      operation(),
      operation({
        path: "/api/v1/campaigns",
        operationId: "listCampaigns",
      }),
    ]);

    let send!: Promise<void>;
    act(() => {
      send = controller().requestSend();
    });
    await flush();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(controller().sending).toBe(true);
    expect(document.body.textContent).toContain("Cancel request");

    act(() => controller().select("GET /api/v1/campaigns"));
    await flush();
    expect(controller().selectedKey).toBe("GET /api/v1/tags");
    await act(async () => controller().requestSend());
    expect(mocks.execute).toHaveBeenCalledTimes(1);

    const signal = mocks.execute.mock.calls[0]?.[3] as AbortSignal;
    act(() => controller().cancel());
    expect(signal.aborted).toBe(true);
    pending.resolve(response({ outcome: "aborted", status: 0 }));
    await act(async () => send);
    expect(controller().sending).toBe(false);
  });

  it("freezes an exact mutation review snapshot and retains no request values in history", async () => {
    const editable = editableTagOperation();
    mocks.execute.mockResolvedValueOnce(
      response({
        body: "private-response",
        status: 202,
        statusText: "Accepted",
      }),
    );
    renderHarness([editable]);
    act(() => {
      controller().updateDraft({
        body: '{"name":"private-body"}',
        customHeaders: [{ key: "Accept", value: "private-custom" }],
        idempotencyKey: "private-idempotency",
      });
      controller().updateDraftMap("path", "id", "private-tag-42");
      controller().updateDraftMap("headers", "If-Match", "private-etag");
    });
    await flush();
    await act(async () => controller().requestSend());
    expect(mocks.execute).not.toHaveBeenCalled();

    const snapshot = controller().review;
    expect(snapshot?.request.resolvedPath).toBe("/api/v1/tags/private-tag-42");
    expect(snapshot?.request.plan.headers).toMatchObject({
      Accept: "private-custom",
      "If-Match": "private-etag",
      "Idempotency-Key": "private-idempotency",
    });
    expect(snapshot?.request.plan.body).toBe('{"name":"private-body"}');

    act(() => controller().updateDraft({ body: '{"changed":true}' }));
    await flush();
    expect(snapshot?.request.plan.body).toBe('{"name":"private-body"}');
    await act(async () => controller().confirmSend());

    expect(mocks.recordHistory).toHaveBeenCalledTimes(1);
    const [scope, retained] = mocks.recordHistory.mock.calls[0] ?? [];
    expect(scope).toBe(HISTORY_SCOPE);
    expect(retained).toMatchObject({
      method: "PATCH",
      pathTemplate: "/api/v1/tags/{id}",
      status: 202,
      durationMs: 18,
      outcome: "http",
      ambiguous: false,
      body: "",
      bodyOmitted: true,
      parameterNamesOmitted: {
        path: ["id"],
        query: [],
        header: ["If-Match", "Idempotency-Key"],
      },
      customHeaderNamesOmitted: ["Accept"],
    });
    expect(retained).not.toHaveProperty("url");
    expect(retained).not.toHaveProperty("resolvedPath");
    const serialized = JSON.stringify(retained);
    for (const value of [
      "private-tag-42",
      "private-etag",
      "private-custom",
      "private-idempotency",
      "private-body",
      "private-response",
    ]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("opens a value-free replay and clears the prior response", async () => {
    const editable = editableTagOperation();
    renderHarness([editable]);
    await prepareEditableDraft();
    await act(async () => controller().requestSend());
    await act(async () => controller().confirmSend());
    expect(controller().response).not.toBeNull();

    act(() => controller().replay(historyEntry(editable)));
    await flush();
    expect(controller().response).toBeNull();
    expect(controller().draft).toMatchObject({
      path: {},
      query: {},
      headers: {},
      customHeaders: [],
      body: "",
      touched: false,
    });
    expect(controller().draft.idempotencyKey).not.toBe("");
  });

  it("retains an ambiguous attempt key until a verified-state new attempt", async () => {
    const editable = editableTagOperation();
    mocks.execute.mockResolvedValueOnce(
      response({
        status: 503,
        statusText: "Unavailable",
        ambiguous: true,
      }),
    );
    renderHarness([editable]);
    await prepareEditableDraft();
    const originalKey = controller().draft.idempotencyKey;

    await act(async () => controller().requestSend());
    await act(async () => controller().confirmSend());
    expect(controller().response?.ambiguous).toBe(true);
    expect(controller().draft.idempotencyKey).toBe(originalKey);

    await act(async () => controller().requestSend());
    await act(async () => controller().confirmSend());
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(controller().draft.idempotencyKey).toBe(originalKey);

    act(() => controller().newAttempt());
    await flush();
    expect(controller().response).toBeNull();
    expect(controller().draft.idempotencyKey).not.toBe(originalKey);
  });

  it("requires verified state before retrying a future non-idempotent unknown outcome", () => {
    const policy = executionPolicyFor(editableTagOperation());
    const ambiguous = response({
      status: 503,
      statusText: "Unavailable",
      ambiguous: true,
    });

    expect(
      playgroundRequiresVerifiedStateBeforeRetry(ambiguous, {
        ...policy,
        idempotency: "none",
      }),
    ).toBe(true);
    expect(playgroundRequiresVerifiedStateBeforeRetry(ambiguous, policy)).toBe(
      false,
    );
    expect(playgroundRequiresVerifiedStateBeforeRetry(response(), policy)).toBe(
      false,
    );
  });

  it("binds a used idempotency key to its exact attempted request", async () => {
    const editable = editableTagOperation();
    renderHarness([editable]);
    await prepareEditableDraft();
    const originalBody = controller().draft.body;

    await act(async () => controller().requestSend());
    await act(async () => controller().confirmSend());
    expect(mocks.execute).toHaveBeenCalledTimes(1);

    act(() => controller().updateDraft({ body: '{"name":"Changed"}' }));
    await flush();
    expect(
      controller()
        .request.issues.map((issue) => issue.message)
        .join(" "),
    ).toContain("already bound to a different exact request");
    expect(controller().request.plan).toMatchObject({
      snippetAllowed: false,
      snippetUnavailableReason: expect.stringContaining(
        "already bound to a different exact request",
      ),
    });
    await act(async () => controller().requestSend());
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(controller().review).toBeNull();

    act(() => controller().updateDraft({ body: originalBody }));
    await flush();
    expect(controller().request.issues).toEqual([]);
    await act(async () => controller().requestSend());
    await act(async () => controller().confirmSend());
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it("warns globally when authority remount aborts an in-flight mutation", async () => {
    const pending = deferred<PlaygroundTransportResponse>();
    mocks.execute.mockReturnValueOnce(pending.promise);
    renderHarness([editableTagOperation()]);
    await prepareEditableDraft();
    await act(async () => controller().requestSend());
    let send!: Promise<void>;
    act(() => {
      send = controller().confirmSend();
    });
    await flush();
    const signal = mocks.execute.mock.calls[0]?.[3] as AbortSignal;

    act(() => root?.unmount());
    root = null;
    expect(signal.aborted).toBe(true);
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Mutation outcome may be unknown",
        detail: expect.stringContaining("Verify server state"),
      }),
    );

    pending.resolve(response({ outcome: "aborted", status: 0 }));
    await act(async () => send);
  });
});
