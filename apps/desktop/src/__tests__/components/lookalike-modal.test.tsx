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

import type { Segment } from "../../components/segments/segmentsClient";
import type { LookalikeModel } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  LOOKALIKE_DEFAULT_SIZE: 1000,
  LOOKALIKE_MAX_SIZE: 10000,
  LOOKALIKE_MIN_SIZE: 100,
  createLookalikeAudience: mocks.create,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { LookalikeModal } from "../../components/audiences/LookalikeModal";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function segment(id: string, name: string, lastCount?: number): Segment {
  return { id, name, lastCount };
}

function model(overrides: Partial<LookalikeModel> = {}): LookalikeModel {
  return {
    id: "audience-1",
    name: "Readers alike",
    seed_segment_id: "seed-1",
    size_requested: 1000,
    member_count: 842,
    seed_count: 75,
    confidence_threshold: 0.8,
    model_version: "first-party-v1",
    status: "ready",
    created_at: "2026-07-15T08:00:00.000Z",
    ...overrides,
  };
}

function modal({
  segments = [segment("seed-1", "Engaged readers", 75)],
  canMutate = true,
  onClose = vi.fn(),
  onCreated = vi.fn(),
}: {
  segments?: Segment[];
  canMutate?: boolean;
  onClose?: () => void;
  onCreated?: (created: LookalikeModel) => void;
} = {}): ReactElement {
  return (
    <LookalikeModal
      segments={segments}
      canMutate={canMutate}
      onClose={onClose}
      onCreated={onCreated}
    />
  );
}

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

function input(id: string, value: string): void {
  const element = document.getElementById(id) as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function acknowledgeDataUse(): void {
  const checkbox = document.querySelector<HTMLInputElement>(
    ".lookalike-acknowledgement input",
  );
  if (!checkbox) throw new Error("Missing lookalike data-use acknowledgement");
  act(() => checkbox.click());
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
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

describe("LookalikeModal", () => {
  it("offers only evaluated seed segments with at least 50 members", () => {
    render(
      modal({
        segments: [
          segment("unknown", "Never evaluated"),
          segment("small", "Small seed", 49),
          segment("eligible", "Eligible seed", 50),
        ],
      }),
    );

    const options = Array.from(
      document.querySelectorAll<HTMLOptionElement>("#lookalike-seed option"),
    );
    expect(options.map((option) => option.value)).toEqual(["eligible"]);
    expect(document.body.textContent).not.toContain("Never evaluated");
    expect(document.body.textContent).not.toContain("Small seed");
  });

  it("keeps unavailable creation discoverable with a guarded reason", () => {
    const view = render(
      modal({ segments: [segment("small", "Small seed", 12)] }),
    );

    expect(document.body.textContent).toContain("No eligible seed segments");
    expect(button("Create lookalike").disabled).toBe(false);
    expect(button("Create lookalike").getAttribute("aria-disabled")).toBe(
      "true",
    );
    act(() => button("Create lookalike").click());
    expect(mocks.create).not.toHaveBeenCalled();

    view.rerender(modal({ canMutate: false }));
    expect(button("Create lookalike").disabled).toBe(false);
    expect(button("Create lookalike").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(button("Create lookalike").getAttribute("aria-describedby")).toEqual(
      expect.any(String),
    );
    expect(document.body.textContent).toContain("Viewer access can configure");
    expect(document.querySelectorAll("button[title]")).toHaveLength(0);
    act(() => button("Create lookalike").click());
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("submits the normalized request and presents the materialized result", async () => {
    const created = model();
    const onCreated = vi.fn();
    mocks.create.mockResolvedValueOnce({ data: created });
    render(modal({ onCreated }));
    input("lookalike-name", "  Readers alike  ");
    acknowledgeDataUse();

    act(() => button("Create lookalike").click());

    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledWith({
        name: "Readers alike",
        seed_segment_id: "seed-1",
        size: 1000,
        confidence_threshold: 0.8,
        data_use_acknowledged: true,
      });
      expect(document.body.textContent).toContain("842");
      expect(document.body.textContent).toContain("first-party-v1");
    });
    expect(document.body.textContent).toContain(
      "Seed segment: Engaged readers",
    );
    expect(onCreated).toHaveBeenCalledWith(created);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Lookalike "Readers alike" created — 842 members',
    );
  });

  it("maps permission failures to an actionable error and keeps the form open", async () => {
    mocks.create.mockResolvedValueOnce({
      error: { status: 403, code: "forbidden", message: "Denied" },
    });
    render(modal());
    acknowledgeDataUse();

    act(() => button("Create lookalike").click());

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Creating a lookalike needs a write role.",
      );
    });
    expect(document.body.textContent).toContain("Create lookalike audience");
    expect(button("Create lookalike").disabled).toBe(false);
  });

  it("suppresses a request completion after the modal is unmounted", async () => {
    const creation = deferred<{ data: LookalikeModel }>();
    const onCreated = vi.fn();
    mocks.create.mockReturnValueOnce(creation.promise);
    const view = render(modal({ onCreated }));
    acknowledgeDataUse();

    act(() => button("Create lookalike").click());
    view.rerender(<Fragment />);
    creation.resolve({ data: model() });
    await act(async () => Promise.resolve());

    expect(onCreated).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
