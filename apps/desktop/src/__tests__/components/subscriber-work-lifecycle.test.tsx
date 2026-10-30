// @vitest-environment happy-dom

import { act, Fragment, type ReactElement } from "react";
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
  canWrite: { value: true },
  configureHoldout: vi.fn(),
  createLookalike: vi.fn(),
  createSegment: vi.fn(),
  exportLookalike: vi.fn(),
  listDestinations: vi.fn(),
  listLookalikes: vi.fn(),
  listSegments: vi.fn(),
  patchList: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  listsExtendedApi: { patch: mocks.patchList },
  audienceDestinationsApi: { list: mocks.listDestinations },
}));

vi.mock("../../lib/store", () => ({
  useCanWrite: () => mocks.canWrite.value,
}));

vi.mock("../../components/segments/segmentsClient", () => ({
  segmentsClient: {
    compileFromText: vi.fn(),
    create: mocks.createSegment,
    list: mocks.listSegments,
  },
}));

vi.mock("../../components/segments/VisualSegmentBuilder", () => ({
  VisualSegmentBuilder: () => null,
}));

vi.mock("../../components/segments/PredicateRegistryCatalog", () => ({
  PredicateRegistryCatalog: () => null,
}));

vi.mock("../../components/segments/SegmentPreviewCount", () => ({
  SegmentPreviewCount: () => null,
}));

vi.mock("../../components/segments/segmentPnlClient", () => ({
  segmentPnlClient: { configureHoldout: mocks.configureHoldout },
}));

vi.mock("../../lib/api/subscriber-lookalike", () => ({
  lookalikeApi: {
    create: mocks.createLookalike,
    export: mocks.exportLookalike,
    list: mocks.listLookalikes,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

import { SettingsTab } from "../../components/lists/tabs/SettingsTab";
import { NaturalLanguageBuilder } from "../../components/segments/NaturalLanguageBuilder";
import { SegmentHoldoutConfigModal } from "../../components/segments/SegmentHoldoutConfigModal";
import { LookalikeGeneratorModal } from "../../components/subscribers/LookalikeGeneratorModal";
import {
  inspectLifecycle,
  prepareLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";
import type { List } from "../../lib/api-client";

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canWrite.value = true;
  mocks.listSegments.mockResolvedValue({
    data: [{ id: "segment-1", name: "Engaged", lastCount: 75 }],
  });
  mocks.listLookalikes.mockResolvedValue({ data: { items: [] } });
  mocks.listDestinations.mockResolvedValue({ data: { items: [] } });
  mocks.patchList.mockResolvedValue({ data: {} });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
});

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender(next) {
      act(() => root?.render(next));
    },
  };
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function setValue(element: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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

function list(): List {
  return {
    id: "list-1",
    name: "Newsletter",
    type: "private",
    optin: "single",
    description: "Main list",
    tags: ["primary"],
  } as unknown as List;
}

describe("subscriber-work lifecycle behavior", () => {
  it("keeps read-only list settings focusable, explained, and inert", () => {
    mocks.canWrite.value = false;
    render(<SettingsTab list={list()} onUpdated={vi.fn()} />);

    const name = document.getElementById(
      "list-settings-name",
    ) as HTMLInputElement;
    const visibility = document.getElementById(
      "list-settings-type",
    ) as HTMLSelectElement;
    const save = button("Save changes");
    expect(name.readOnly).toBe(true);
    expect(name.disabled).toBe(false);
    expect(visibility.disabled).toBe(false);
    expect(visibility.getAttribute("aria-disabled")).toBe("true");
    expect(save.disabled).toBe(false);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.getAttribute("title")).toBeNull();
    expect(document.body.textContent).toContain("Viewer access is read-only");

    act(() => save.click());
    expect(mocks.patchList).not.toHaveBeenCalled();
  });

  it("keeps create drafts discard-only and requires an explicit local discard", async () => {
    const onClose = vi.fn();
    render(
      <NaturalLanguageBuilder
        open
        initialAst={{ op: "and", conditions: [] }}
        initialName="Seeded segment"
        onClose={onClose}
        onCreated={vi.fn()}
      />,
    );
    await flush();

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "New segment draft",
        level: "warning",
        canSave: false,
        canDiscard: true,
      },
    ]);
    await act(async () => prepareLifecycle(quitIntent));
    expect(mocks.createSegment).not.toHaveBeenCalled();

    act(() => button("Cancel").click());
    expect(button("Discard draft")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => button("Discard draft").click());
    expect(onClose).toHaveBeenCalledOnce();
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("retains a failed existing-setting draft and prepares the acknowledged retry", async () => {
    mocks.patchList
      .mockResolvedValueOnce({ error: { message: "temporary failure" } })
      .mockResolvedValueOnce({ data: {} });
    render(<SettingsTab list={list()} onUpdated={vi.fn()} />);
    setValue(
      document.getElementById("list-settings-name") as HTMLInputElement,
      "Customer newsletter",
    );

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Settings for Newsletter",
        canSave: true,
        canDiscard: true,
      },
    ]);
    await act(async () => prepareLifecycle(quitIntent));
    expect(mocks.patchList).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toHaveLength(1);

    await act(async () => prepareLifecycle(quitIntent));
    expect(mocks.patchList).toHaveBeenCalledTimes(2);
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("keeps the exact operation blocking after its modal unmounts", async () => {
    const request = deferred<{ data: Record<string, never> }>();
    mocks.configureHoldout.mockReturnValue(request.promise);
    render(
      <SegmentHoldoutConfigModal
        segmentId="segment-1"
        onClose={vi.fn()}
        onConfigured={vi.fn()}
      />,
    );
    setValue(
      document.querySelector<HTMLInputElement>('input[type="range"]')!,
      "20",
    );
    act(() => button("Save holdout").click());

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Segment holdout configuration",
        level: "blocking",
        canSave: false,
        canDiscard: false,
      },
    ]);
    act(() => root?.unmount());
    root = null;
    await expect(inspectLifecycle(quitIntent)).resolves.toHaveLength(1);

    await act(async () => request.resolve({ data: {} }));
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("retains a dirty lookalike draft while its controlled modal is hidden", async () => {
    const view = render(
      <LookalikeGeneratorModal open canMutate onClose={vi.fn()} />,
    );
    await flush();
    setValue(
      document.getElementById("lookalike-name") as HTMLInputElement,
      "High-value lookalike",
    );

    view.rerender(
      <LookalikeGeneratorModal open={false} canMutate onClose={vi.fn()} />,
    );
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Subscriber lookalike generation draft",
        canSave: false,
        canDiscard: true,
      },
    ]);
    view.rerender(<LookalikeGeneratorModal open canMutate onClose={vi.fn()} />);
    expect(
      (document.getElementById("lookalike-name") as HTMLInputElement).value,
    ).toBe("High-value lookalike");
    await act(async () => prepareLifecycle(quitIntent));
    expect(mocks.createLookalike).not.toHaveBeenCalled();
  });

  it("keeps concurrent copies instance-safe without a registry collision", async () => {
    render(
      <Fragment>
        <NaturalLanguageBuilder
          open
          initialAst={{ field: "status", op: "eq", value: "enabled" }}
          initialName="Enabled one"
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />
        <NaturalLanguageBuilder
          open
          initialAst={{ field: "status", op: "eq", value: "disabled" }}
          initialName="Disabled one"
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />
      </Fragment>,
    );
    await flush();

    const concerns = await inspectLifecycle(quitIntent);
    expect(concerns).toHaveLength(2);
    expect(concerns.map((concern) => concern.label)).toEqual([
      "New segment draft",
      "New segment draft",
    ]);
    expect(concerns).not.toContainEqual(
      expect.objectContaining({ label: "Conflicting lifecycle safety owners" }),
    );
  });
});
