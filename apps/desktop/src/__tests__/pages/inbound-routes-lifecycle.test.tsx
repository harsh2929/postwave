// @vitest-environment happy-dom

import { act, type ReactElement, useState } from "react";
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
  discardAndRecheckLifecycleTransition,
  inspectLifecycle,
  requestLifecycleTransition,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  patch: vi.fn(),
  destroy: vi.fn(),
  preview: vi.fn(),
  clipboard: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    inboundRouteCreate: mocks.create,
    inboundRoutePatch: mocks.patch,
    inboundRouteDelete: mocks.destroy,
    inboundRoutePreview: mocks.preview,
  },
  getApiUrl: () => "https://api.example.test",
}));

vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: mocks.clipboard,
  clipboardSuccessDetail: () => "The clipboard will clear after 60 seconds.",
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../components/inbound/InboundRouteDiagnostics", () => ({
  MatchHistoryPanel: ({ routeId }: { routeId: string }) => (
    <div data-testid="history">History for {routeId}</div>
  ),
  ProviderSnippetsCard: () => null,
  formatInboundRouteRelative: () => "never",
  formatInboundRouteAbsolute: () => "Jul 16, 2026, 9:00 AM",
}));

vi.mock("../../lib/heroAssets", () => ({
  HERO: { inboundRoutes: "/inbound-routes.png" },
}));

import {
  EndpointCard,
  inboundRouteDraftFingerprint,
  RouteModal,
  TestMatchPanel,
} from "../../pages/InboundRoutes";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

const route: InboundRoute = {
  id: "route-1",
  name: "Support route",
  priority: 10,
  stop_on_match: true,
  enabled: true,
  match_recipient: "support@*",
  match_subject_prefix: "[urgent]",
  match_from_domain: "example.test",
  actions: [
    {
      kind: "webhook",
      url: "https://hooks.example.test/inbound",
      extra: { custom: "preserved" },
      has_stored_hmac_secret: true,
    },
  ],
  match_count: 3,
  updated_at: "2026-08-30T10:00:00.000Z",
};

const endpoint: InboundEmailEndpoint = {
  id: "endpoint-1",
  tenantId: "tenant-1",
  slug: "inbound-slug",
  secretConfigured: true,
  rotationRequired: false,
  secretRotatedAt: "2026-07-16T09:00:00Z",
  secret: "shown-once-endpoint-secret",
  createdAt: "2026-07-16T08:00:00Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ data: route });
  mocks.patch.mockResolvedValue({ data: route });
  mocks.destroy.mockResolvedValue({ data: { deleted: true } });
  mocks.preview.mockResolvedValue({
    data: { matches: [], evaluated: 1, no_matches: true },
  });
  mocks.clipboard.mockResolvedValue({
    ok: true,
    cleanup: { status: "scheduled", afterMs: 60_000 },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
  vi.clearAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flushEffects(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function button(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function click(target: HTMLElement): void {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function key(target: HTMLElement, value: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: value,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function changeInput(target: HTMLInputElement, value: string): void {
  // React tracks controlled values on the instance; invoke the native setter
  // so the following input event is observed as an operator edit.
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function RouteHarness({
  onSaved = async () => {},
}: {
  onSaved?: () => Promise<void>;
}): ReactElement {
  const [open, setOpen] = useState(true);
  return open ? (
    <RouteModal
      mode="edit"
      existing={route}
      onClose={() => setOpen(false)}
      onSaved={onSaved}
    />
  ) : (
    <div data-testid="closed">Closed</div>
  );
}

function EndpointHarness({
  onRotated = async () => true,
}: {
  onRotated?: () => Promise<boolean>;
}): ReactElement {
  const [current, setCurrent] = useState(endpoint);
  return (
    <EndpointCard
      endpoint={current}
      canAdmin
      onRotated={onRotated}
      onSecretHandled={() =>
        setCurrent((previous) => {
          const { secret: _secret, ...metadata } = previous;
          void _secret;
          return metadata;
        })
      }
    />
  );
}

describe("inbound routes lifecycle and secret behavior", () => {
  it("fingerprints every matcher, route control, action order, and HMAC edit", () => {
    const base: Parameters<typeof inboundRouteDraftFingerprint>[0] = {
      name: "Route",
      recipient: "support@*",
      subjectPrefix: "[urgent]",
      fromDomain: "example.test",
      priority: "10",
      stopOnMatch: true,
      actions: [
        {
          uid: "ignored-local-id",
          kind: "webhook",
          url: "https://example.test/hook",
          hmac_secret: "draft-secret",
          remove_hmac_secret: false,
        },
      ],
    };
    const original = inboundRouteDraftFingerprint(base);
    const variants: Array<Parameters<typeof inboundRouteDraftFingerprint>[0]> =
      [
        { ...base, name: "Changed" },
        { ...base, recipient: "billing@*" },
        { ...base, subjectPrefix: "[billing]" },
        { ...base, fromDomain: "sender.test" },
        { ...base, priority: "0" },
        { ...base, stopOnMatch: false },
        {
          ...base,
          actions: [{ ...base.actions[0]!, url: "https://other.test" }],
        },
        {
          ...base,
          actions: [{ ...base.actions[0]!, hmac_secret: "replacement" }],
        },
        {
          ...base,
          actions: [{ ...base.actions[0]!, remove_hmac_secret: true }],
        },
        {
          ...base,
          actions: [{ uid: "new", kind: "tag", tag: "first" }, ...base.actions],
        },
      ];
    expect(
      variants.every(
        (variant) => inboundRouteDraftFingerprint(variant) !== original,
      ),
    ).toBe(true);
    expect(
      inboundRouteDraftFingerprint({
        ...base,
        actions: [{ ...base.actions[0]!, uid: "different-local-id" }],
      }),
    ).toBe(original);
  });

  it("never pre-fills a stored HMAC secret and requires explicit local discard", async () => {
    render(<RouteHarness />);
    const password = document.querySelector<HTMLInputElement>(
      'input[aria-label="HMAC signing secret"]',
    );
    expect(password?.value).toBe("");
    expect(password?.placeholder).toContain("keep stored secret");
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);

    const name = document.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Support catch-all"]',
    )!;
    changeInput(name, "Changed route");
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Inbound route changes",
        level: "blocking",
        canSave: false,
        canDiscard: true,
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

    click(button("History (3 matches)"));
    await flushEffects();
    expect(document.body.textContent).toContain(
      "Discard changes and view history?",
    );
    expect(mocks.patch).not.toHaveBeenCalled();
    click(button("Discard changes"));
    await flushEffects();
    expect(document.querySelector('[data-testid="history"]')).not.toBeNull();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("owns route panels and manually activates lazy history from the keyboard", () => {
    render(<RouteHarness />);
    const list = document.querySelector<HTMLElement>(
      '[role="tablist"][aria-label="Inbound route editor sections"]',
    )!;
    const config = button("Configuration");
    const history = button("History (3 matches)");
    const configPanel = document.getElementById(
      config.getAttribute("aria-controls")!,
    );
    const historyPanel = document.getElementById(
      history.getAttribute("aria-controls")!,
    );
    expect(configPanel?.getAttribute("aria-labelledby")).toBe(config.id);
    expect(configPanel?.getAttribute("role")).toBe("tabpanel");
    expect(historyPanel?.getAttribute("aria-labelledby")).toBe(history.id);
    expect(historyPanel?.getAttribute("role")).toBe("tabpanel");
    expect(
      [...list.querySelectorAll('[role="tab"]')].filter(
        (item) => (item as HTMLElement).tabIndex === 0,
      ),
    ).toHaveLength(1);

    act(() => config.focus());
    expect(key(config, "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(history);
    expect(config.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector('[data-testid="history"]')).toBeNull();
    key(history, "Enter");
    expect(history.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector('[data-testid="history"]')).not.toBeNull();
    expect(list.contains(button("Close"))).toBe(false);
    key(history, "Home");
    expect(document.activeElement).toBe(config);
    expect(history.getAttribute("aria-selected")).toBe("true");
    key(config, " ");
    expect(config.getAttribute("aria-selected")).toBe("true");
  });

  it("global discard closes and zeroizes without auto-saving or previewing", async () => {
    const proceeded = vi.fn();
    render(<RouteHarness />);
    const password = document.querySelector<HTMLInputElement>(
      'input[aria-label="HMAC signing secret"]',
    )!;
    changeInput(password, "local-plaintext-only");

    const transition = requestLifecycleTransition(quitIntent, proceeded);
    await flushEffects();
    await act(async () => discardAndRecheckLifecycleTransition());
    await expect(transition).resolves.toBe("proceeded");
    expect(proceeded).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="closed"]')).not.toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("single-flights save, preserves opaque stored extras, and zeroizes a replacement", async () => {
    const request = deferred<{ data: InboundRoute }>();
    const onSaved = vi.fn(async () => {});
    mocks.patch.mockReset().mockReturnValue(request.promise);
    render(<RouteHarness onSaved={onSaved} />);
    const password = document.querySelector<HTMLInputElement>(
      'input[aria-label="HMAC signing secret"]',
    )!;
    changeInput(password, "replacement-secret");
    const form = document.querySelector("form")!;

    act(() => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Inbound route update",
        level: "blocking",
        canSave: false,
        canDiscard: false,
      },
    ]);
    expect(mocks.patch).toHaveBeenCalledWith(
      "route-1",
      expect.objectContaining({
        actions: [
          expect.objectContaining({
            kind: "webhook",
            extra: {
              custom: "preserved",
              hmac_secret: "replacement-secret",
            },
          }),
        ],
      }),
    );

    await act(async () => {
      request.resolve({ data: route });
      await request.promise;
    });
    await flushEffects();
    expect(onSaved).toHaveBeenCalledOnce();
    expect(password.value).toBe("");
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("retains a retryable HMAC draft after a thrown save and releases busy state", async () => {
    mocks.patch
      .mockReset()
      .mockRejectedValueOnce(new Error("do not expose transport internals"))
      .mockResolvedValueOnce({ data: route });
    render(<RouteHarness />);
    const password = document.querySelector<HTMLInputElement>(
      'input[aria-label="HMAC signing secret"]',
    )!;
    changeInput(password, "retry-secret");
    click(button("Save changes"));
    await flushEffects();

    expect(password.value).toBe("retry-secret");
    expect(button("Save changes").disabled).toBe(false);
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "do not expose transport internals",
    );
    click(button("Save changes"));
    await flushEffects();
    expect(mocks.patch).toHaveBeenCalledTimes(2);
  });

  it("guards endpoint plaintext until copy-and-clear or explicit abandon", async () => {
    render(<EndpointHarness />);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Inbound endpoint signing secret",
        level: "blocking",
        canSave: false,
        canDiscard: false,
      },
    ]);

    click(button("Copy and clear"));
    await flushEffects();
    expect(mocks.clipboard).toHaveBeenCalledWith(
      "shown-once-endpoint-secret",
      expect.objectContaining({
        contentClass: "secret",
        clearIfUnchangedAfterMs: 60_000,
      }),
    );
    expect(document.body.textContent).not.toContain(
      "shown-once-endpoint-secret",
    );
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("requires abandon-before-rotation and single-flights the replacement request", async () => {
    const rotation = deferred<boolean>();
    const onRotated = vi.fn(() => rotation.promise);
    render(<EndpointHarness onRotated={onRotated} />);

    click(button("Rotate"));
    expect(document.body.textContent).toContain(
      "The currently revealed plaintext has not been acknowledged.",
    );
    const confirm = button("Discard reveal and rotate");
    act(() => {
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRotated).toHaveBeenCalledTimes(1);
    await act(async () => {
      rotation.resolve(true);
      await rotation.promise;
    });
  });

  it("guards preview drafts and releases a thrown preview for retry", async () => {
    mocks.preview
      .mockReset()
      .mockRejectedValueOnce(new Error("private transport detail"))
      .mockResolvedValueOnce({
        data: { matches: [], evaluated: 1, no_matches: true },
      });
    render(<TestMatchPanel routes={[route]} />);
    const recipient = document.querySelector<HTMLInputElement>(
      'input[placeholder="support@acme.com"]',
    )!;
    changeInput(recipient, "person@example.test");
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Inbound route preview draft",
        level: "warning",
        canSave: false,
        canDiscard: true,
      },
    ]);

    const run = button("Run preview");
    act(() => {
      run.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      run.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Preview did not complete");
    expect(button("Run preview").disabled).toBe(false);
    click(button("Run preview"));
    await flushEffects();
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "private transport detail",
    );
  });

  it("keeps an empty preview action focusable, described, and guarded", () => {
    render(<TestMatchPanel routes={[]} />);
    const run = button("Run preview");
    expect(run.disabled).toBe(false);
    expect(run.getAttribute("aria-disabled")).toBe("true");
    const descriptionId = run.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(descriptionId)?.textContent).toContain(
      "Create at least one route",
    );
    click(run);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(document.querySelectorAll("button[title]")).toHaveLength(0);
  });
});
