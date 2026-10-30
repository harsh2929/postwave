// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
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

import type { InboundEmailEndpoint, InboundRoute } from "../../lib/api-client";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const mocks = vi.hoisted(() => ({
  canAdmin: true,
  inboundRoutesList: vi.fn(),
  inboundEndpointGet: vi.fn(),
  inboundRoutePatch: vi.fn(),
  inboundRoutesReorder: vi.fn(),
  inboundRouteCreate: vi.fn(),
  inboundEndpointRotate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

vi.mock("../../lib/api-client", () => ({
  api: {
    inboundRoutesList: mocks.inboundRoutesList,
    inboundEndpointGet: mocks.inboundEndpointGet,
    inboundRoutePatch: mocks.inboundRoutePatch,
    inboundRoutesReorder: mocks.inboundRoutesReorder,
    inboundRouteCreate: mocks.inboundRouteCreate,
    inboundEndpointRotate: mocks.inboundEndpointRotate,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import {
  inboundRouteStats,
  type InboundRoutesController,
  useInboundRoutesController,
} from "../../pages/inbound-routes/useInboundRoutesController";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function route(
  id: string,
  overrides: Partial<InboundRoute> = {},
): InboundRoute {
  return {
    id,
    name: `Route ${id}`,
    priority: id === "a" ? 10 : 20,
    stop_on_match: true,
    enabled: id === "a",
    match_recipient: `${id}@example.test`,
    match_subject_prefix: `[${id}]`,
    match_from_domain: "sender.example.test",
    actions: [{ kind: "tag", tag: id }],
    match_count: id === "a" ? 7 : 3,
    updated_at: "2026-08-30T10:00:00.000Z",
    ...overrides,
  };
}

function endpoint(
  slug: string,
  overrides: Partial<InboundEmailEndpoint> = {},
): InboundEmailEndpoint {
  return {
    id: `endpoint-${slug}`,
    tenantId: "tenant-1",
    slug,
    secretConfigured: true,
    rotationRequired: false,
    createdAt: "2026-07-16T08:00:00Z",
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: InboundRoutesController | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAdmin = true;
  mocks.inboundRoutesList.mockResolvedValue({
    data: { routes: [route("a"), route("b")] },
  });
  mocks.inboundEndpointGet.mockResolvedValue({ data: endpoint("initial") });
  mocks.inboundRoutePatch.mockResolvedValue({ data: route("a") });
  mocks.inboundRoutesReorder.mockResolvedValue({ data: { ok: true } });
  mocks.inboundRouteCreate.mockResolvedValue({ data: route("copy") });
  mocks.inboundEndpointRotate.mockResolvedValue({
    data: endpoint("rotated", { secret: "shown-once" }),
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  latest = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
  vi.clearAllMocks();
});

function Probe(): ReactElement {
  const controller = useInboundRoutesController();
  latest = controller;
  return (
    <div>
      <span data-testid="rows">
        {controller.rows?.map((item) => item.id).join(",") ?? "null"}
      </span>
      <span data-testid="endpoint">{controller.endpoint?.slug ?? "null"}</span>
      <span data-testid="endpoint-status">{controller.endpointStatus}</span>
      <span data-testid="endpoint-error">
        {controller.endpointErr ?? "none"}
      </span>
      <span data-testid="loading">{String(controller.loading)}</span>
      <span data-testid="error">{controller.err ?? "none"}</span>
    </div>
  );
}

function renderController(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Probe />));
}

async function flushEffects(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function textByTestId(testId: string): string | null {
  return (
    container?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
  );
}

describe("inbound routes controller", () => {
  it("retains the exact route rollup and thin renderer boundary", () => {
    expect(inboundRouteStats(null).map((cell) => cell.value)).toEqual([
      "—",
      "—",
      "—",
    ]);
    expect(inboundRouteStats([route("a"), route("b")])).toEqual([
      { label: "Routes", value: "2" },
      {
        label: "Enabled",
        value: "1",
        hint: "Disabled rules are skipped during evaluation; they stay in the table for reference.",
      },
      {
        label: "Total matches",
        value: "10",
        hint: "Cumulative match count across all rules since each was created.",
      },
    ]);

    const page = readFileSync("src/pages/InboundRoutes.tsx", "utf8");
    expect(page).toContain("useInboundRoutesController");
    expect(page).toContain("InboundRoutesPresentation");
    expect(page).toMatch(
      /export function InboundRoutes\(\): ReactElement \{\s+const controller = useInboundRoutesController\(\);\s+return <InboundRoutesPresentation controller=\{controller\} \/>;\s+\}/,
    );
    const budgets = readFileSync(
      "scripts/function-quality-budgets.json",
      "utf8",
    );
    expect(budgets).not.toContain('"src/pages/InboundRoutes.tsx"');
  });

  it("single-flights reload and permits a new refresh after settlement", async () => {
    const initialRoutes = deferred<{ data: { routes: InboundRoute[] } }>();
    const initialEndpoint = deferred<{ data: InboundEmailEndpoint }>();
    const newRoutes = deferred<{ data: { routes: InboundRoute[] } }>();
    const newEndpoint = deferred<{ data: InboundEmailEndpoint }>();
    mocks.inboundRoutesList
      .mockReset()
      .mockImplementationOnce(() => initialRoutes.promise)
      .mockImplementationOnce(() => newRoutes.promise);
    mocks.inboundEndpointGet
      .mockReset()
      .mockImplementationOnce(() => initialEndpoint.promise)
      .mockImplementationOnce(() => newEndpoint.promise);

    renderController();
    expect(mocks.inboundRoutesList).toHaveBeenCalledTimes(1);
    let joinedReload!: Promise<void>;
    act(() => {
      joinedReload = latest!.reload();
    });
    expect(mocks.inboundRoutesList).toHaveBeenCalledTimes(1);

    await act(async () => {
      initialRoutes.resolve({ data: { routes: [route("initial")] } });
      initialEndpoint.resolve({ data: endpoint("initial") });
      await joinedReload;
    });
    expect(textByTestId("rows")).toBe("initial");
    expect(textByTestId("endpoint")).toBe("initial");
    expect(textByTestId("loading")).toBe("false");
    expect(textByTestId("error")).toBe("none");

    let nextReload!: Promise<void>;
    act(() => {
      nextReload = latest!.reload();
    });
    expect(mocks.inboundRoutesList).toHaveBeenCalledTimes(2);
    await act(async () => {
      newRoutes.resolve({ data: { routes: [route("new")] } });
      newEndpoint.resolve({ data: endpoint("new") });
      await nextReload;
    });
    expect(textByTestId("rows")).toBe("new");
    expect(textByTestId("endpoint")).toBe("new");
    expect(textByTestId("loading")).toBe("false");
    expect(textByTestId("error")).toBe("none");
  });

  it("preserves toggle, reorder, duplicate, and one-shot rotation semantics", async () => {
    renderController();
    await flushEffects();
    const first = latest!.rows![0];
    const second = latest!.rows![1];

    await act(async () => latest!.toggleEnabled(first));
    expect(mocks.inboundRoutePatch).toHaveBeenCalledWith("a", {
      enabled: false,
    });

    await act(async () => latest!.move(second, -1));
    expect(mocks.inboundRoutesReorder).toHaveBeenLastCalledWith(["b", "a"]);

    await act(async () => latest!.reorder("a", "b", false));
    expect(mocks.inboundRoutesReorder).toHaveBeenLastCalledWith(["b", "a"]);

    await act(async () => latest!.duplicate(first));
    expect(mocks.inboundRouteCreate).toHaveBeenCalledWith({
      name: "Route a (copy)",
      priority: 11,
      stop_on_match: true,
      enabled: false,
      match_recipient: "a@example.test",
      match_subject_prefix: "[a]",
      match_from_domain: "sender.example.test",
      actions: [{ kind: "tag", tag: "a" }],
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith({
      message: "Route duplicated",
      detail:
        "The copy is disabled and webhook signing secrets were removed — review credentials before enabling it.",
    });

    await expect(act(async () => latest!.rotateEndpoint())).resolves.toBe(true);
    expect(textByTestId("endpoint")).toBe("rotated");
    expect(mocks.toastSuccess).toHaveBeenLastCalledWith({
      message: "Signing secret rotated",
      detail: "Copy the new secret now and update your signing proxy.",
    });
  });

  it("closes same-tick mutation gaps and blocks exit while allowing hide", async () => {
    const patchRequest = deferred<{ data: InboundRoute }>();
    mocks.inboundRoutePatch.mockReset().mockReturnValue(patchRequest.promise);
    renderController();
    await flushEffects();
    const first = latest!.rows![0];

    let firstRequest!: Promise<void>;
    let duplicateRequest!: Promise<void>;
    act(() => {
      firstRequest = latest!.toggleEnabled(first);
      duplicateRequest = latest!.toggleEnabled(first);
    });

    expect(mocks.inboundRoutePatch).toHaveBeenCalledTimes(1);
    expect(latest!.activeOperations).toEqual(new Set(["route:a:toggle"]));
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Route disable",
        level: "blocking",
        canSave: false,
        canDiscard: false,
        canRecover: false,
      },
    ]);
    await expect(
      inspectLifecycle({
        ...quitIntent,
        kind: "close-window",
        disposition: "hide",
      }),
    ).resolves.toEqual([]);

    await act(async () => {
      patchRequest.resolve({ data: route("a", { enabled: false }) });
      await Promise.all([firstRequest, duplicateRequest]);
    });
    expect(latest!.activeOperations.size).toBe(0);
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("retains the process guard across unmount and suppresses late UI work", async () => {
    const request = deferred<{ data: InboundRoute }>();
    mocks.inboundRouteCreate.mockReset().mockReturnValue(request.promise);
    renderController();
    await flushEffects();

    let operation!: Promise<void>;
    act(() => {
      operation = latest!.duplicate(latest!.rows![0]);
    });
    act(() => root?.unmount());
    root = null;

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Inbound route duplication",
        level: "blocking",
      },
    ]);
    request.resolve({ data: route("copy") });
    await operation;
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith({
      message: "Route duplicated",
      detail:
        "The copy is disabled and webhook signing secrets were removed — review credentials before enabling it.",
    });
  });

  it("contains thrown mutations, releases locks in finally, and permits retry", async () => {
    mocks.inboundRoutesReorder
      .mockReset()
      .mockRejectedValueOnce(new Error("transport detail must not surface"))
      .mockResolvedValue({ data: { ok: true } });
    mocks.inboundEndpointRotate
      .mockReset()
      .mockRejectedValueOnce(new Error("secret-bearing transport detail"))
      .mockResolvedValue({
        data: endpoint("retry", { secret: "shown-once-retry" }),
      });
    renderController();
    await flushEffects();

    await act(async () => latest!.move(latest!.rows![1], -1));
    expect(latest!.activeOperations.size).toBe(0);
    expect(mocks.toastError).toHaveBeenLastCalledWith({
      message: "Couldn't reorder routes",
      detail:
        "Route reorder did not complete. Check your connection and try again.",
    });
    await act(async () => latest!.move(latest!.rows![1], -1));
    expect(mocks.inboundRoutesReorder).toHaveBeenCalledTimes(2);

    await expect(act(async () => latest!.rotateEndpoint())).resolves.toBe(
      false,
    );
    expect(latest!.activeOperations.size).toBe(0);
    await expect(act(async () => latest!.rotateEndpoint())).resolves.toBe(true);
    expect(mocks.inboundEndpointRotate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "secret-bearing transport detail",
    );
  });

  it("settles initial loading when list and endpoint transports throw", async () => {
    mocks.inboundRoutesList.mockReset().mockRejectedValue(new Error("offline"));
    mocks.inboundEndpointGet
      .mockReset()
      .mockRejectedValue(new Error("offline"));
    renderController();
    await flushEffects();

    expect(textByTestId("loading")).toBe("false");
    expect(textByTestId("rows")).toBe("null");
    expect(textByTestId("endpoint")).toBe("null");
    expect(textByTestId("endpoint-status")).toBe("error");
    expect(textByTestId("endpoint-error")).toContain(
      "Couldn't verify the inbound endpoint",
    );
    expect(textByTestId("error")).toBe(
      "Couldn't load inbound routes. Check your connection and retry.",
    );
  });

  it("rejects malformed reads and never surfaces backend error prose", async () => {
    mocks.inboundRoutesList.mockReset().mockResolvedValue({
      data: {
        routes: [
          {
            id: "malformed-route",
            hidden: "private subscriber and database host",
          },
        ],
      },
    });
    mocks.inboundEndpointGet.mockReset().mockResolvedValue({
      error: {
        message: "private endpoint database and signing material",
        kind: "http",
        status: 500,
        requestId: "request-safe-identifier-001",
      },
    });
    renderController();
    await flushEffects();

    expect(textByTestId("rows")).toBe("null");
    expect(textByTestId("error")).toContain("response was incomplete");
    expect(textByTestId("endpoint-status")).toBe("error");
    expect(textByTestId("endpoint-error")).toContain(
      "request-safe-identifier-001",
    );
    expect(document.body.textContent).not.toContain("private subscriber");
    expect(document.body.textContent).not.toContain("private endpoint");
  });

  it("fails closed when rotation omits the one-time plaintext", async () => {
    mocks.inboundEndpointRotate.mockReset().mockResolvedValue({
      data: endpoint("metadata-only"),
    });
    renderController();
    await flushEffects();

    await expect(act(async () => latest!.rotateEndpoint())).resolves.toBe(
      false,
    );
    expect(latest!.endpoint).toMatchObject({
      slug: "metadata-only",
      rotationRequired: true,
    });
    expect(latest!.endpoint?.secret).toBeUndefined();
    expect(mocks.toastError).toHaveBeenLastCalledWith({
      message: "Signing secret changed without a usable reveal",
      detail:
        "Do not send traffic with the previous value. Rotate again to obtain a new one-time secret.",
    });
  });

  it("does not propagate a webhook signing secret into a duplicate", async () => {
    renderController();
    await flushEffects();
    const original = route("secret", {
      actions: [
        {
          kind: "webhook",
          url: "https://hooks.example.test/inbound",
          extra: {
            hmac_secret: "must-not-spread",
            content_type: "application/json",
          },
        },
      ],
    });

    await act(async () => latest!.duplicate(original));
    expect(mocks.inboundRouteCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [
          {
            kind: "webhook",
            url: "https://hooks.example.test/inbound",
            extra: { content_type: "application/json" },
          },
        ],
      }),
    );
    expect(JSON.stringify(mocks.inboundRouteCreate.mock.calls)).not.toContain(
      "must-not-spread",
    );
  });
});
