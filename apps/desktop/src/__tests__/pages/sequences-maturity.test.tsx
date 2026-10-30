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
  canWrite: true,
  roleStatus: "resolved" as "loading" | "resolved" | "error",
  listSequences: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanWrite: () => mocks.canWrite,
  useRoleStatus: () => mocks.roleStatus,
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listSequences: mocks.listSequences,
    createSequence: vi.fn(),
    draftSequence: vi.fn(),
  },
}));

vi.mock("../../components/sequence/StepCanvas", () => ({
  StepCanvas: ({ sequence }: { sequence: { id?: string | number } }) => (
    <section aria-label="Sequence canvas">Canvas {String(sequence.id)}</section>
  ),
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock("../../lib/heroAssets", () => ({
  HERO: { sequences: "sequences.webp" },
}));

import {
  getDesktopRoute,
  requestDesktopRouteNavigation,
} from "../../lib/desktop-router";
import { Sequences } from "../../pages/Sequences";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const rows = [
  { id: "seq-a", name: "Welcome draft", status: "draft", steps: 3 },
  { id: "seq-b", name: "Win-back draft", status: "archived", steps: 4 },
];

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  mocks.canWrite = true;
  mocks.roleStatus = "resolved";
  mocks.listSequences.mockReset();
  mocks.listSequences.mockResolvedValue({ data: { items: rows } });
  await act(async () => {
    await requestDesktopRouteNavigation(
      { section: "sequences" },
      { replace: true },
    );
  });
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement = <Sequences />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

describe("Sequences route maturity", () => {
  it("uses the canonical resource route for row open, A-to-B replacement, and Back", async () => {
    render();
    await flush();

    const welcome = document.querySelector<HTMLButtonElement>(
      '[aria-label="Open Welcome draft in the draft builder"]',
    );
    expect(welcome).not.toBeNull();
    act(() => welcome?.click());
    await flush();
    expect(getDesktopRoute().resourceId).toBe("seq-a");
    expect(document.body.textContent).toContain("Canvas seq-a");

    await act(async () => {
      await requestDesktopRouteNavigation({
        section: "sequences",
        resourceId: "seq-b",
      });
    });
    expect(document.body.textContent).toContain("Canvas seq-b");
    expect(document.body.textContent).not.toContain("Canvas seq-a");

    act(() => button("← All sequences").click());
    await flush();
    expect(getDesktopRoute().resourceId).toBeUndefined();
    expect(document.body.textContent).toContain("Welcome draft");
  });

  it("opens a cold resource route without waiting for local selection state", async () => {
    await act(async () => {
      await requestDesktopRouteNavigation(
        { section: "sequences", resourceId: "seq-b" },
        { replace: true },
      );
    });
    render();
    await flush();
    expect(document.body.textContent).toContain("Canvas seq-b");
    expect(document.body.textContent).not.toContain("Canvas seq-a");
  });

  it("fails invalid or duplicate library identities closed and fails creation authority closed", async () => {
    mocks.canWrite = false;
    mocks.roleStatus = "error";
    mocks.listSequences.mockResolvedValue({
      data: {
        items: [
          { id: "duplicate", name: "One", status: "draft", steps: 1 },
          { id: "duplicate", name: "Two", status: "draft", steps: 2 },
        ],
      },
    });
    render();
    await flush();

    expect(document.body.textContent).toContain("Sequence library unavailable");
    expect(document.body.textContent).toContain(
      "No empty-state or deletion claim is being inferred.",
    );
    const newDraft = button("New draft");
    expect(newDraft.disabled).toBe(false);
    expect(newDraft.getAttribute("aria-disabled")).toBe("true");
    act(() => newDraft.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain("Runtime off");
  });

  it.each([
    [{ id: 0, name: "Zero", status: "draft", steps: 1 }],
    [{ id: "blank-name", name: "   ", status: "draft", steps: 1 }],
    [{ id: "unknown-status", name: "Unknown", status: "live", steps: 1 }],
  ])("rejects malformed library row semantics: %j", async (invalidRows) => {
    mocks.listSequences.mockResolvedValue({ data: { items: invalidRows } });
    render();
    await flush();

    expect(document.body.textContent).toContain("Sequence library unavailable");
    expect(document.body.textContent).toContain(
      "No empty-state or deletion claim is being inferred.",
    );
  });
});
