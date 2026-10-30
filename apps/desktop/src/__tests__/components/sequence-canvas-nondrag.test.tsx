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

import { StepCanvas } from "../../components/sequence/StepCanvas";
import { api, type Sequence, type SequenceDetail } from "../../lib/api-client";

vi.mock("../../components/Toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("../../components/sequence/StepEditor", () => ({
  StepEditor: ({
    step,
    onCancel,
  }: {
    step: { type: string };
    onCancel: () => void;
  }) => (
    <div role="dialog" aria-label={`Edit ${step.type} step`}>
      <button type="button" onClick={onCancel}>
        Cancel editor
      </button>
    </div>
  ),
}));

import {
  inspectLifecycle,
  prepareLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

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
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    callback(0);
    return 1;
  };
  vi.spyOn(api, "getSequenceFunnel").mockResolvedValue({
    data: { sequence_id: "sequence-1", steps: [] },
  });
  vi.spyOn(api, "updateSequence").mockResolvedValue({
    data: { version: 2 },
  });
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function sequence(): Sequence {
  return {
    id: "sequence-1",
    name: "Welcome sequence",
    status: "draft",
    active_runs: 0,
  } as Sequence;
}

function detail(steps: SequenceDetail["steps"]): SequenceDetail {
  return {
    id: "sequence-1",
    name: "Welcome sequence",
    status: "draft",
    active_runs: 0,
    version: 1,
    steps,
  } as SequenceDetail;
}

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

function click(element: Element | null): void {
  expect(element).not.toBeNull();
  act(() => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("StepCanvas non-drag completion paths", () => {
  it("makes the draft/runtime boundary persistent and keeps operational controls inert", async () => {
    const getSequenceFunnel = vi.spyOn(api, "getSequenceFunnel");
    vi.spyOn(api, "getSequence").mockResolvedValue({
      data: detail([
        {
          type: "email",
          position: 1,
          email: { subject: "First email", body: "Hello" },
        },
      ]),
    });
    render(<StepCanvas sequence={sequence()} canMutate />);
    await flush();

    expect(document.body.textContent).toContain(
      "Design the journey here. Keep live delivery off.",
    );
    expect(document.body.textContent).toContain("Draft & review");
    expect(document.body.textContent).toContain("Runtime required");
    const subscribers = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent?.trim() === "Subscribers");
    const metrics = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent?.trim() === "Refresh metrics");
    expect(subscribers?.disabled).toBe(true);
    expect(metrics?.disabled).toBe(true);
    expect(getSequenceFunnel).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("active runs");
    expect(document.body.textContent).not.toContain(
      "No subscribers have entered",
    );
  });

  it("locks mutation when the server omits its concurrency version", async () => {
    vi.spyOn(api, "getSequence").mockResolvedValue({
      data: { ...detail([]), version: undefined },
    });
    render(<StepCanvas sequence={sequence()} canMutate />);
    await flush();

    expect(document.body.textContent).toContain(
      "Editing is locked because the server did not provide a valid concurrency version.",
    );
    expect(
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="Add Email step at the end"]',
        )
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    click(document.querySelector('[aria-label="Add Email step at the end"]'));
    expect(api.updateSequence).not.toHaveBeenCalled();
  });

  it("keeps read-only keyboard navigation from opening an editable step dialog", async () => {
    vi.spyOn(api, "getSequence").mockResolvedValue({
      data: detail([
        {
          type: "email",
          position: 1,
          email: { subject: "First email", body: "Hello" },
        },
      ]),
    });
    render(<StepCanvas sequence={sequence()} canMutate={false} />);
    await flush();

    const node = document.querySelector<HTMLElement>(".step-node-main");
    expect(node).not.toBeNull();
    act(() => {
      node?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api.updateSequence).not.toHaveBeenCalled();
  });

  it("keeps an unconfirmed save visible and retries the exact failed draft", async () => {
    vi.spyOn(api, "getSequence").mockResolvedValue({ data: detail([]) });
    vi.mocked(api.updateSequence)
      .mockResolvedValueOnce({
        error: {
          status: 503,
          code: "service_unavailable",
          message: "Sequence storage is unavailable.",
        },
      })
      .mockResolvedValueOnce({ data: { version: 2 } });
    render(<StepCanvas sequence={sequence()} canMutate />);
    await flush();

    click(document.querySelector('[aria-label="Add Email step at the end"]'));
    await flush();
    expect(document.body.textContent).toContain("Draft save needs attention.");
    expect(document.body.textContent).toContain(
      "Sequence storage is unavailable.",
    );
    expect(api.updateSequence).toHaveBeenCalledTimes(1);

    click(
      Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === "Retry failed change",
      ) ?? null,
    );
    await flush();
    expect(api.updateSequence).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(
      "Draft save needs attention.",
    );
    expect(
      document.querySelectorAll(".step-node-wrap > .step-node"),
    ).toHaveLength(1);
  });

  it("never retries a stale conflict snapshot and reloads only after explicit discard", async () => {
    vi.spyOn(api, "getSequence")
      .mockResolvedValueOnce({ data: detail([]) })
      .mockResolvedValueOnce({
        data: {
          ...detail([
            {
              type: "delay",
              position: 1,
              delay: { seconds: 86_400, value: 1, unit: "days" },
            },
          ]),
          version: 2,
        },
      });
    vi.mocked(api.updateSequence).mockResolvedValueOnce({
      error: {
        status: 412,
        code: "precondition_failed",
        message: "The sequence version is stale.",
      },
    });
    render(<StepCanvas sequence={sequence()} canMutate />);
    await flush();

    click(document.querySelector('[aria-label="Add Email step at the end"]'));
    await flush();
    expect(document.body.textContent).toContain("Draft save needs attention.");
    expect(document.body.textContent).toContain(
      "This sequence was edited in another tab.",
    );
    expect(document.body.textContent).not.toContain("Retry failed change");
    expect(api.updateSequence).toHaveBeenCalledTimes(1);

    click(
      Array.from(document.querySelectorAll("button")).find(
        (candidate) =>
          candidate.textContent?.trim() === "Reload latest version",
      ) ?? null,
    );
    expect(document.body.textContent).toContain(
      "Discard the failed change and reload?",
    );
    expect(api.getSequence).toHaveBeenCalledTimes(1);

    click(
      Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === "Discard and reload",
      ) ?? null,
    );
    await flush();

    expect(api.getSequence).toHaveBeenCalledTimes(2);
    expect(api.updateSequence).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(
      "Draft save needs attention.",
    );
    expect(
      document
        .querySelector<HTMLElement>(".step-node-main")
        ?.getAttribute("aria-label"),
    ).toContain("Delay");
  });

  it("treats a nominal save without the exact next version as an uncertain conflict", async () => {
    vi.spyOn(api, "getSequence").mockResolvedValue({ data: detail([]) });
    vi.mocked(api.updateSequence).mockResolvedValueOnce({
      data: { version: 1 },
    });
    render(<StepCanvas sequence={sequence()} canMutate />);
    await flush();

    click(document.querySelector('[aria-label="Add Email step at the end"]'));
    await flush();

    expect(api.updateSequence).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Draft save needs attention.");
    expect(document.body.textContent).toContain(
      "The server did not confirm the next sequence version.",
    );
    expect(document.body.textContent).toContain("Reload latest version");
    expect(document.body.textContent).not.toContain("Retry failed change");
    expect(document.body.textContent).toContain(
      "Editing is locked because the server did not provide a valid concurrency version.",
    );
    expect(
      document.querySelectorAll(".step-node-wrap > .step-node"),
    ).toHaveLength(0);
  });

  it("preserves a pending reorder when a blank tag is added, cancelled, and navigation prepares", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "getSequence").mockResolvedValue({
      data: detail([
        {
          type: "email",
          position: 1,
          email: { subject: "First email", body: "Hello" },
        },
        {
          type: "delay",
          position: 2,
          delay: { seconds: 86_400, value: 1, unit: "days" },
        },
      ]),
    });
    render(<StepCanvas sequence={sequence()} canMutate />);
    await flush();

    click(document.querySelector('[aria-label="Move step 1 later"]'));
    click(document.querySelector('[aria-label="Add Add tag step at the end"]'));
    expect(api.updateSequence).not.toHaveBeenCalled();

    click(
      Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === "Cancel editor",
      ) ?? null,
    );
    await act(async () => prepareLifecycle(quitIntent));
    await flush();

    expect(api.updateSequence).toHaveBeenCalledTimes(1);
    expect(api.updateSequence).toHaveBeenCalledWith(
      "sequence-1",
      {
        steps: [
          expect.objectContaining({ type: "delay", position: 1 }),
          expect.objectContaining({ type: "email", position: 2 }),
        ],
      },
      1,
    );
    await vi.runAllTimersAsync();
    expect(api.updateSequence).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("adds at the end and reorders top-level steps with native buttons", async () => {
    vi.spyOn(api, "getSequence").mockResolvedValue({
      data: detail([
        {
          type: "email",
          position: 1,
          email: { subject: "First email", body: "Hello" },
        },
        {
          type: "delay",
          position: 2,
          delay: { seconds: 86_400, value: 1, unit: "days" },
        },
      ]),
    });
    render(
      <StepCanvas sequence={sequence()} canMutate onSequenceChange={vi.fn()} />,
    );
    await flush();

    const nodes = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          ".step-node-wrap > .step-node > .step-node-main",
        ),
      );
    expect(nodes()).toHaveLength(2);
    click(document.querySelector('[aria-label="Move step 1 later"]'));
    expect(nodes()[0]?.getAttribute("aria-label")).toContain("Delay");
    expect(document.body.textContent).toContain(
      "Moved Email step to position 2 of 2.",
    );

    click(document.querySelector('[aria-label="Add Email step at the end"]'));
    await flush();
    expect(nodes()).toHaveLength(3);
    expect(document.body.textContent).toContain(
      "Added Email step. Its editor is open.",
    );
    expect(api.updateSequence).toHaveBeenCalled();
  });

  it("adds and reorders steps inside a condition branch without dragging", async () => {
    vi.spyOn(api, "getSequence").mockResolvedValue({
      data: detail([
        {
          type: "condition",
          position: 1,
          condition: {
            predicate: "opened_previous",
            value: "",
            yes_branch: [
              {
                type: "email",
                position: 1,
                email: { subject: "Branch email", body: "Hello" },
              },
              {
                type: "delay",
                position: 2,
                delay: { seconds: 3_600, value: 1, unit: "hours" },
              },
            ],
            no_branch: [],
          },
        },
      ]),
    });
    render(<StepCanvas sequence={sequence()} canMutate />);
    await flush();

    const yesBranch = document.querySelector<HTMLElement>(".step-branch-yes");
    const branchNodes = () =>
      Array.from(
        yesBranch?.querySelectorAll<HTMLElement>(
          ":scope > .step-branch-node-row .step-node-main",
        ) ?? [],
      );
    expect(branchNodes()).toHaveLength(2);
    click(yesBranch?.querySelector('[aria-label="Move step 1 later"]') ?? null);
    expect(branchNodes()[0]?.getAttribute("aria-label")).toContain("Delay");

    const select = yesBranch?.querySelector<HTMLSelectElement>(
      '[aria-label="Step type for Yes branch"]',
    );
    act(() => {
      if (!select) return;
      select.value = "delay";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    click(
      yesBranch?.querySelector(
        '[role="group"][aria-label="Add step to Yes branch"] button',
      ) ?? null,
    );
    expect(branchNodes()).toHaveLength(3);
    expect(document.body.textContent).toContain(
      "Added Delay step to the Yes branch. Its editor is open.",
    );
  });
});
