// @vitest-environment happy-dom

import { act, type ReactElement, type ReactNode } from "react";
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
  listRoutines: vi.fn(),
  createRoutine: vi.fn(),
  updateRoutine: vi.fn(),
  removeRoutine: vi.fn(),
  runRoutine: vi.fn(),
  listRuns: vi.fn(),
  listLists: vi.fn(),
  listSegments: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { listLists: mocks.listLists },
  agentRoutinesApi: {
    list: mocks.listRoutines,
    create: mocks.createRoutine,
    update: mocks.updateRoutine,
    remove: mocks.removeRoutine,
    run: mocks.runRoutine,
    listRuns: mocks.listRuns,
  },
}));

vi.mock("../../components/segments/segmentsClient", () => ({
  segmentsClient: { list: mocks.listSegments },
}));

vi.mock("../../lib/store", () => ({
  useCanWrite: () => true,
}));

vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: () => null,
}));

vi.mock("../../components/Modal", () => ({
  Modal: ({
    open,
    title,
    children,
  }: {
    open: boolean;
    title: string;
    children: ReactNode;
  }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ) : null,
  ModalFooter: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../../components/Toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { RoutinesPanel } from "../../components/ai/RoutinesPanel";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listRoutines.mockResolvedValue({ data: { items: [] } });
  mocks.createRoutine.mockResolvedValue({ data: routine() });
  mocks.updateRoutine.mockResolvedValue({ data: routine() });
  mocks.removeRoutine.mockResolvedValue({ data: { ok: true } });
  mocks.runRoutine.mockResolvedValue({
    data: { run_id: "run-1", status: "running" },
  });
  mocks.listRuns.mockResolvedValue({ data: { items: [] } });
  mocks.listLists.mockResolvedValue({ data: { results: [] } });
  mocks.listSegments.mockResolvedValue({
    data: [
      { id: "canonical-segment-001", name: "Recently engaged subscribers" },
    ],
  });
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

async function settle(): Promise<void> {
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

function setInput(
  target: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      target,
      value,
    );
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelect(target: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(target, value);
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function routine(overrides: Record<string, unknown> = {}) {
  return {
    id: "routine-001",
    name: "Weekly engagement brief",
    prompt: "Draft a weekly engagement campaign.",
    kind: "draft_campaign",
    schedule: "weekly",
    target_segment_id: "canonical-segment-001",
    require_approval: true,
    enabled: true,
    created_at: "2026-07-18T12:00:00Z",
    updated_at: "2026-07-18T12:00:00Z",
    ...overrides,
  };
}

async function openNewRoutine(): Promise<void> {
  render(<RoutinesPanel />);
  await settle();
  act(() => button("+ New routine").click());
}

describe("agent routine canonical segment picker", () => {
  it("does not expose the incompatible Listmonk list catalog as a routine target", async () => {
    await openNewRoutine();
    await settle();

    expect(
      document.querySelector<HTMLSelectElement>("#routine-target-list"),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("Target list (optional)");
    expect(mocks.listLists).not.toHaveBeenCalled();
  });

  it("shows loading before exposing canonical segment choices", async () => {
    let resolveSegments!: (value: unknown) => void;
    mocks.listSegments.mockReturnValue(
      new Promise((resolve) => {
        resolveSegments = resolve;
      }),
    );
    await openNewRoutine();

    const picker = document.querySelector<HTMLSelectElement>(
      "#routine-target-segment",
    );
    if (!picker) throw new Error("Missing target segment picker");
    expect(picker.disabled).toBe(true);
    expect(picker.textContent).toContain("Loading canonical segments…");
    expect(document.body.textContent).toContain(
      "Verifying canonical audience definitions…",
    );

    await act(async () => {
      resolveSegments({
        data: [
          {
            id: "canonical-segment-001",
            name: "Recently engaged subscribers",
          },
        ],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(picker.disabled).toBe(false);
    expect(Array.from(picker.options).map((option) => option.value)).toEqual([
      "",
      "canonical-segment-001",
    ]);
  });

  it("resolves a stored canonical id to its name and persists canonical selection", async () => {
    mocks.listRoutines.mockResolvedValue({
      data: { items: [routine()] },
    });
    render(<RoutinesPanel />);
    await settle();
    act(() => button("Edit").click());
    await settle();

    const picker = document.querySelector<HTMLSelectElement>(
      "#routine-target-segment",
    );
    if (!picker) throw new Error("Missing target segment picker");
    expect(picker.value).toBe("canonical-segment-001");
    expect(picker.selectedOptions[0]?.textContent).toBe(
      "Recently engaged subscribers",
    );

    mocks.listSegments.mockResolvedValueOnce({
      data: [{ id: "canonical-segment-002", name: "High-intent subscribers" }],
    });
    // Reopening against a refreshed catalog exercises stored-name resolution
    // without allowing a Directory saved-view id into the request.
    act(() => button("Cancel").click());
    act(() => button("Edit").click());
    await settle();
    const reopened = document.querySelector<HTMLSelectElement>(
      "#routine-target-segment",
    );
    if (!reopened) throw new Error("Missing reopened segment picker");
    setSelect(reopened, "canonical-segment-002");
    act(() => button("Save changes").click());
    await settle();

    expect(mocks.updateRoutine).toHaveBeenCalledWith(
      "routine-001",
      expect.objectContaining({
        target_segment_id: "canonical-segment-002",
      }),
    );
  });

  it("distinguishes verified-empty from failure and preserves edits across retry", async () => {
    mocks.listSegments
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        error: {
          kind: "network",
          code: "offline",
          message: "private tenant and gateway detail",
        },
      })
      .mockResolvedValueOnce({
        data: [{ id: "canonical-segment-002", name: "Recovered segment" }],
      });
    await openNewRoutine();
    await settle();
    expect(document.body.textContent).toContain(
      "No canonical segments exist yet.",
    );
    expect(document.body.textContent).not.toContain(
      "Couldn't verify canonical segments.",
    );

    // Close/reopen to consume the explicit failure response.
    act(() => button("Cancel").click());
    act(() => button("+ New routine").click());
    await settle();
    expect(document.body.textContent).toContain(
      "Couldn't verify canonical segments.",
    );
    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain("private tenant");

    const name = document.querySelector<HTMLInputElement>("#routine-name");
    const prompt =
      document.querySelector<HTMLTextAreaElement>("#routine-prompt");
    if (!name || !prompt) throw new Error("Missing routine draft fields");
    setInput(name, "Do not erase this name");
    setInput(prompt, "Do not erase this brief either.");
    act(() => button("Retry segments").click());
    await settle();

    expect(name.value).toBe("Do not erase this name");
    expect(prompt.value).toBe("Do not erase this brief either.");
    expect(mocks.listSegments).toHaveBeenCalledTimes(3);
    const picker = document.querySelector<HTMLSelectElement>(
      "#routine-target-segment",
    );
    if (!picker) throw new Error("Missing recovered segment picker");
    expect(Array.from(picker.options).map((option) => option.value)).toContain(
      "canonical-segment-002",
    );
  });

  it("rejects a Directory saved-view envelope as a malformed canonical catalog", async () => {
    mocks.listSegments.mockResolvedValue({
      data: {
        items: [{ id: "saved-view-id", name: "Directory bookmark" }],
      },
    });
    await openNewRoutine();
    await settle();

    expect(document.body.textContent).toContain(
      "Couldn't verify canonical segments.",
    );
    expect(document.body.textContent).toContain(
      "The server could not verify this data.",
    );
    expect(document.body.textContent).not.toContain("Directory bookmark");
    const picker = document.querySelector<HTMLSelectElement>(
      "#routine-target-segment",
    );
    if (!picker) throw new Error("Missing target segment picker");
    expect(Array.from(picker.options).map((option) => option.value)).toEqual([
      "",
    ]);
  });

  it("keeps a persisted legacy list reference inert unless cleanup is explicit", async () => {
    const legacyListID = "00000000-0000-4000-8000-000000000042";
    mocks.listRoutines.mockResolvedValue({
      data: { items: [routine({ target_list_id: legacyListID })] },
    });
    render(<RoutinesPanel />);
    await settle();
    act(() => button("Edit").click());
    await settle();

    expect(document.body.textContent).toContain(
      "Legacy list target is inactive.",
    );
    expect(document.body.textContent).toContain(
      "It is ignored by every run and has never selected the draft audience.",
    );
    expect(document.body.textContent).not.toContain(legacyListID);
    act(() => button("Save changes").click());
    await settle();

    const patch = mocks.updateRoutine.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(patch).not.toHaveProperty("target_list_id");
  });

  it("clears an inert legacy list reference only after operator confirmation", async () => {
    mocks.listRoutines.mockResolvedValue({
      data: {
        items: [
          routine({
            target_list_id: "00000000-0000-4000-8000-000000000042",
          }),
        ],
      },
    });
    render(<RoutinesPanel />);
    await settle();
    act(() => button("Edit").click());
    await settle();

    act(() => button("Remove legacy reference on save").click());
    expect(document.body.textContent).toContain(
      "The inert reference will be removed only when this edit is saved.",
    );
    act(() => button("Save changes").click());
    await settle();

    expect(mocks.updateRoutine).toHaveBeenCalledWith(
      "routine-001",
      expect.objectContaining({ target_list_id: "" }),
    );
  });
});
