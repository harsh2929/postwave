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
  create: vi.fn(),
  update: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    goalsApi: {
      ...actual.goalsApi,
      create: mocks.create,
      update: mocks.update,
    },
  };
});

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { GoalEditorModal } from "../../components/dashboard/GoalsCard";
import type { TenantGoal } from "../../lib/api-client";
import {
  inspectLifecycle,
  prepareLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

const goal: TenantGoal = {
  id: "goal-1",
  name: "Monthly subscribers",
  metric: "subscribers",
  target: 1_000,
  period: "monthly",
  starts_at: "2026-07-01T00:00:00.000Z",
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.create.mockResolvedValue({ data: goal });
  mocks.update.mockResolvedValue({ data: goal });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function control(label: string): HTMLInputElement | HTMLSelectElement {
  const labelNode = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim().startsWith(label),
  );
  const id = labelNode?.getAttribute("for");
  const found = id
    ? document.getElementById(id)
    : labelNode?.querySelector("input, select");
  if (
    !(found instanceof HTMLInputElement || found instanceof HTMLSelectElement)
  ) {
    throw new Error(`Expected control: ${label}`);
  }
  return found;
}

function setValue(
  target: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  act(() => {
    const prototype =
      target instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      target,
      value,
    );
    target.dispatchEvent(
      new Event(target instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("goal editor lifecycle", () => {
  it("keeps create drafts discard-only and requires local confirmation", async () => {
    const onClose = vi.fn();
    render(<GoalEditorModal goal={null} onClose={onClose} onSaved={vi.fn()} />);
    setValue(control("Name"), "Pipeline target");
    setValue(control("Target"), "2500");

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "New goal draft",
        canSave: false,
        canDiscard: true,
      },
    ]);
    await act(async () => prepareLifecycle(quitIntent));
    expect(mocks.create).not.toHaveBeenCalled();

    act(() => button("Cancel").click());
    expect(document.body.textContent).toContain("Discard goal draft?");
    expect(onClose).not.toHaveBeenCalled();
    act(() => button("Discard").click());
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("awaits one exact edit save and advances the acknowledged baseline", async () => {
    const pending = deferred<{ data: TenantGoal }>();
    mocks.update.mockReturnValueOnce(pending.promise);
    const onSaved = vi.fn();
    render(<GoalEditorModal goal={goal} onClose={vi.fn()} onSaved={onSaved} />);
    setValue(control("Target"), "1500");

    const preparing = prepareLifecycle(quitIntent);
    await flush();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith("goal-1", {
      name: "Monthly subscribers",
      target: 1_500,
      period: "monthly",
    });
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { level: "blocking", canSave: false, canDiscard: false },
    ]);

    await act(async () => {
      pending.resolve({ data: { ...goal, target: 1_500 } });
      await preparing;
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("contains an edit rejection and keeps the draft retryable", async () => {
    const sensitiveFailure = "postgres://admin:secret@internal-db/goals";
    mocks.update.mockRejectedValueOnce(new Error(sensitiveFailure));
    const onSaved = vi.fn();
    render(<GoalEditorModal goal={goal} onClose={vi.fn()} onSaved={onSaved} />);
    setValue(control("Target"), "1750");

    await act(async () => prepareLifecycle(quitIntent));
    expect(onSaved).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Goal couldn't be saved. Review the form, then check your access and connection before retrying.",
    );
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      sensitiveFailure,
    );
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { canSave: true, canDiscard: true },
    ]);
  });

  it("does not disclose a server error envelope from a rejected edit", async () => {
    const sensitiveFailure = "api-key=pw_live_internal_goal_secret";
    mocks.update.mockResolvedValueOnce({
      error: { code: "PRIVATE_STORE_ERROR", message: sensitiveFailure },
    });
    const onSaved = vi.fn();
    render(<GoalEditorModal goal={goal} onClose={vi.fn()} onSaved={onSaved} />);
    setValue(control("Target"), "1800");

    await act(async () => prepareLifecycle(quitIntent));

    expect(onSaved).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Goal couldn't be saved. Review the form, then check your access and connection before retrying.",
    );
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      sensitiveFailure,
    );
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { canSave: true, canDiscard: true },
    ]);
  });
});
