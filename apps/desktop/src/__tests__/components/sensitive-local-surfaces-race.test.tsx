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
  identity: { user: "user-a", tenant: "workspace-1" },
  load: vi.fn(),
  save: vi.fn(),
  getVoiceTemplates: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useMe: () => mocks.identity,
}));
vi.mock("../../lib/sensitive-local-data", () => ({
  loadSensitiveLocalData: mocks.load,
  saveSensitiveLocalData: mocks.save,
  sensitiveLocalIdentityScope: (user: string, tenant: string) =>
    `${user}:${tenant}`,
}));
vi.mock("../../lib/api-client", () => ({
  api: { getVoiceTemplates: mocks.getVoiceTemplates },
}));

import { SavedPromptsCard } from "../../components/ai/SavedPromptsCard";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.identity = { user: "user-a", tenant: "workspace-1" };
  mocks.load.mockReset();
  mocks.save.mockReset();
  mocks.getVoiceTemplates.mockReset();
  mocks.getVoiceTemplates.mockResolvedValue({ data: { items: [] } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(node: ReactElement): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(node));
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await act(async () => Promise.resolve());
    }
  }
  throw failure;
}

function loadResult(name: string, prompt: string) {
  return {
    value: [{ id: name, name, prompt }],
    state: "ready" as const,
    warning: null,
    retryable: false,
  };
}

describe("sensitive local surface hydration races", () => {
  it("blocks edits during hydration and ignores completion after unmount", async () => {
    const pending = deferred<ReturnType<typeof loadResult>>();
    mocks.load.mockReturnValue(pending.promise);
    render(
      <SavedPromptsCard currentPrompt="Private draft" onApply={vi.fn()} />,
    );

    const save = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "+ Save",
    );
    expect(save?.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      document.querySelector('input[aria-label="Prompt name"]'),
    ).toBeNull();

    act(() => root?.unmount());
    root = null;
    await act(async () => pending.resolve(loadResult("Old", "Old content")));
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does not let a superseded identity read overwrite the active workspace", async () => {
    const first = deferred<ReturnType<typeof loadResult>>();
    const second = deferred<ReturnType<typeof loadResult>>();
    mocks.load
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const node = () => (
      <SavedPromptsCard currentPrompt="Draft" onApply={vi.fn()} />
    );
    render(node());

    mocks.identity = { user: "user-b", tenant: "workspace-2" };
    render(node());
    await act(async () => second.resolve(loadResult("Workspace B", "B only")));
    await waitFor(() =>
      expect(document.body.textContent).toContain("Workspace B"),
    );

    await act(async () => first.resolve(loadResult("Workspace A", "A only")));
    expect(document.body.textContent).toContain("Workspace B");
    expect(document.body.textContent).not.toContain("Workspace A");
  });

  it("clears a naming draft and discards superseded tenant templates on identity change", async () => {
    mocks.load.mockResolvedValue({
      value: [],
      state: "ready",
      warning: null,
      retryable: false,
    });
    const firstTemplates = deferred<{
      data: {
        items: Array<{
          id: string;
          name: string;
          description: string;
        }>;
      };
    }>();
    const secondTemplates = deferred<{
      data: {
        items: Array<{
          id: string;
          name: string;
          description: string;
        }>;
      };
    }>();
    mocks.getVoiceTemplates
      .mockReturnValueOnce(firstTemplates.promise)
      .mockReturnValueOnce(secondTemplates.promise);
    const node = () => (
      <SavedPromptsCard
        currentPrompt="Private workspace brief"
        onApply={vi.fn()}
      />
    );
    render(node());
    await waitFor(() =>
      expect(document.body.textContent).not.toContain(
        "Loading encrypted saved prompts",
      ),
    );
    const save = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "+ Save",
    );
    act(() => save?.click());
    expect(
      document.querySelector('input[aria-label="Prompt name"]'),
    ).not.toBeNull();

    mocks.identity = { user: "user-b", tenant: "workspace-2" };
    render(node());
    expect(
      document.querySelector('input[aria-label="Prompt name"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("Workspace A starter");

    secondTemplates.resolve({
      data: {
        items: [
          {
            id: "workspace-b",
            name: "Workspace B starter",
            description: "B only",
          },
        ],
      },
    });
    await act(async () => secondTemplates.promise);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Workspace B starter"),
    );

    firstTemplates.resolve({
      data: {
        items: [
          {
            id: "workspace-a",
            name: "Workspace A starter",
            description: "A only",
          },
        ],
      },
    });
    await act(async () => firstTemplates.promise);
    expect(document.body.textContent).toContain("Workspace B starter");
    expect(document.body.textContent).not.toContain("Workspace A starter");
  });
});
