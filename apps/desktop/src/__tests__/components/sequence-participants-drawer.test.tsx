// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { act } from "react";
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

import type {
  SequenceParticipant,
  SequenceParticipantsResponse,
} from "../../lib/api-client";
import type { CanvasStep } from "../../components/sequence/types";

const mocks = vi.hoisted(() => ({
  listSequenceParticipants: vi.fn(),
  setSection: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listSequenceParticipants: mocks.listSequenceParticipants,
  },
  isSequenceParticipantsUnavailable: (error: {
    kind?: string;
    status?: number;
  } | undefined) => error?.kind === "http" && error.status === 404,
}));

vi.mock("../../lib/store", () => ({
  setSection: mocks.setSection,
}));

vi.mock("../../components/SlideoverShell", () => ({
  SlideoverShell: ({
    children,
    title,
    subtitle,
  }: {
    children: React.ReactNode;
    title: string;
    subtitle?: string;
  }) => (
    <section aria-label={title}>
      <div data-testid="drawer-subtitle">{subtitle}</div>
      {children}
    </section>
  ),
}));

vi.mock("../../components/sequence/SequenceStuckPanel", () => ({
  SequenceStuckPanel: ({
    sequenceId,
    stuckAfterDays,
  }: {
    sequenceId: string | number;
    stuckAfterDays: number;
  }) => (
    <div data-testid="stuck-panel">
      Stuck {sequenceId} after {stuckAfterDays} days
    </div>
  ),
}));

import {
  resolveStepLabel,
  SequenceParticipantsDrawer,
} from "../../components/sequence/SequenceParticipantsDrawer";

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

function success(
  items: SequenceParticipant[],
  total = items.length,
): { data: SequenceParticipantsResponse } {
  return {
    data: { items, total, page: 1, per_page: 50 },
  };
}

function participant(
  email: string,
  overrides: Partial<SequenceParticipant> = {},
): SequenceParticipant {
  return {
    subscriber_id: email,
    email,
    current_step: 2,
    entered_at: "2026-07-15T10:00:00.000Z",
    last_event_at: "2026-07-16T10:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

const steps: CanvasStep[] = [
  { id: "welcome", type: "email", position: 1, subject: "Welcome" },
  { id: "wait", type: "delay", position: 2, delay_value: 1 },
  { id: "offer", type: "email", position: 3, subject: "Offer" },
];

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
  vi.clearAllMocks();
  mocks.listSequenceParticipants.mockResolvedValue(
    success([participant("alice@example.test")], 101),
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function renderDrawer(
  options: Partial<React.ComponentProps<typeof SequenceParticipantsDrawer>> = {},
): void {
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.appendChild(container);
  root ??= createRoot(container);
  const props: React.ComponentProps<typeof SequenceParticipantsDrawer> = {
    open: true,
    onClose: vi.fn(),
    sequenceId: "sequence/one",
    steps,
    activeRunsHint: 7,
    stuckAfterDays: 3,
    ...options,
  };
  act(() => root?.render(<SequenceParticipantsDrawer {...props} />));
}

async function flushEffects(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(container?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(found).toBeDefined();
  return found!;
}

function click(element: HTMLElement): void {
  act(() => element.click());
}

describe("SequenceParticipantsDrawer", () => {
  it("forwards exact browse state, resets pagination once, and opens subscriber profiles", async () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });
    await flushEffects();

    expect(mocks.listSequenceParticipants).toHaveBeenNthCalledWith(
      1,
      "sequence/one",
      {
        status: "all",
        sort: "entered_at_desc",
        page: 1,
        perPage: 50,
      },
    );
    expect(container?.textContent).toContain("101 subscribers");
    expect(container?.textContent).toContain("Step 2 · Email · Offer");
    expect(button("All").getAttribute("aria-pressed")).toBe("true");

    click(button("Next →"));
    await flushEffects();
    expect(mocks.listSequenceParticipants).toHaveBeenNthCalledWith(
      2,
      "sequence/one",
      expect.objectContaining({ status: "all", page: 2, perPage: 50 }),
    );

    click(button("Completed"));
    await flushEffects();
    expect(mocks.listSequenceParticipants).toHaveBeenCalledTimes(3);
    expect(mocks.listSequenceParticipants).toHaveBeenLastCalledWith(
      "sequence/one",
      {
        status: "completed",
        sort: "entered_at_desc",
        page: 1,
        perPage: 50,
      },
    );

    const sort = container?.querySelector<HTMLSelectElement>(
      "#seq-participants-sort",
    );
    expect(sort).not.toBeNull();
    act(() => {
      sort!.value = "current_step_desc";
      sort!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushEffects();
    expect(mocks.listSequenceParticipants).toHaveBeenCalledTimes(4);
    expect(mocks.listSequenceParticipants).toHaveBeenLastCalledWith(
      "sequence/one",
      {
        status: "completed",
        sort: "current_step_desc",
        page: 1,
        perPage: 50,
      },
    );

    click(
      container!.querySelector<HTMLButtonElement>(
        'button[aria-label="Open profile for alice@example.test"]',
      )!,
    );
    expect(mocks.setSection).toHaveBeenCalledWith("subscribers");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest request and invalidates pending work on close and unmount", async () => {
    const first = deferred<ReturnType<typeof success>>();
    const second = deferred<ReturnType<typeof success>>();
    const whileClosing = deferred<ReturnType<typeof success>>();
    const whileUnmounting = deferred<ReturnType<typeof success>>();
    mocks.listSequenceParticipants
      .mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(whileClosing.promise)
      .mockReturnValueOnce(whileUnmounting.promise);

    renderDrawer();
    click(button("Completed"));
    expect(mocks.listSequenceParticipants).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(success([participant("current@example.test")], 1));
      await second.promise;
    });
    expect(container?.textContent).toContain("current@example.test");

    await act(async () => {
      first.resolve(success([participant("stale@example.test")], 1));
      await first.promise;
    });
    expect(container?.textContent).toContain("current@example.test");
    expect(container?.textContent).not.toContain("stale@example.test");

    const sort = container!.querySelector<HTMLSelectElement>(
      "#seq-participants-sort",
    )!;
    act(() => {
      sort.value = "current_step_desc";
      sort.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(mocks.listSequenceParticipants).toHaveBeenCalledTimes(3);
    renderDrawer({ open: false });
    expect(container?.textContent).toBe("");
    await act(async () => {
      whileClosing.resolve(
        success([participant("after-close@example.test")], 1),
      );
      await whileClosing.promise;
    });
    expect(container?.textContent).toBe("");

    renderDrawer();
    expect(mocks.listSequenceParticipants).toHaveBeenCalledTimes(4);
    await act(async () => {
      root?.unmount();
      root = null;
      whileUnmounting.resolve(
        success([participant("after-unmount@example.test")], 1),
      );
      await whileUnmounting.promise;
    });
    expect(container?.textContent).toBe("");
  });

  it("never exposes rows from a previously selected sequence", async () => {
    const nextSequence = deferred<ReturnType<typeof success>>();
    renderDrawer();
    await flushEffects();
    expect(container?.textContent).toContain("alice@example.test");

    mocks.listSequenceParticipants.mockReturnValueOnce(nextSequence.promise);
    renderDrawer({ sequenceId: "sequence/two" });
    expect(mocks.listSequenceParticipants).toHaveBeenLastCalledWith(
      "sequence/two",
      expect.any(Object),
    );
    expect(container?.textContent).not.toContain("alice@example.test");
    expect(
      container?.querySelector(
        '[role="status"][aria-label="Loading sequence participants"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      nextSequence.resolve(
        success([participant("second-sequence@example.test")], 1),
      );
      await nextSequence.promise;
    });
    expect(container?.textContent).toContain("second-sequence@example.test");
    expect(container?.textContent).not.toContain("alice@example.test");
  });

  it("distinguishes unavailable deployments from retryable failures", async () => {
    mocks.listSequenceParticipants
      .mockReset()
      .mockResolvedValueOnce({
        error: { kind: "http", status: 503, message: "database unavailable" },
      })
      .mockResolvedValueOnce(success([participant("recovered@example.test")], 1));
    renderDrawer();
    await flushEffects();

    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load participants: database unavailable",
    );
    click(button("Retry"));
    await flushEffects();
    expect(mocks.listSequenceParticipants).toHaveBeenCalledTimes(2);
    expect(container?.textContent).toContain("recovered@example.test");

    act(() => root?.unmount());
    root = null;
    container?.replaceChildren();
    mocks.listSequenceParticipants.mockReset().mockResolvedValueOnce({
      error: { kind: "http", status: 404, message: "not found" },
    });
    renderDrawer();
    await flushEffects();
    expect(container?.querySelector('[role="status"]')?.textContent).toContain(
      "participants list isn't available",
    );
    expect(container?.textContent).toContain("Not available on this server");
    expect(
      Array.from(container?.querySelectorAll("button") ?? []).some(
        (candidate) => candidate.textContent?.trim() === "Retry",
      ),
    ).toBe(false);
  });

  it("supports keyboard tab navigation and preserves safe step labels", async () => {
    renderDrawer();
    await flushEffects();
    const participantsTab = button("Participants");
    const stuckTab = button("Stuck");
    participantsTab.focus();
    act(() => {
      participantsTab.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(stuckTab);
    expect(stuckTab.getAttribute("aria-selected")).toBe("true");
    const activePanel = container?.querySelector<HTMLElement>(
      '[role="tabpanel"]:not([hidden])',
    );
    expect(activePanel?.getAttribute("aria-labelledby")).toBe(stuckTab.id);
    expect(stuckTab.getAttribute("aria-controls")).toBe(activePanel?.id);
    expect(container?.textContent).toContain(
      "Stuck sequence/one after 3 days",
    );

    const serverLabel = participant("server@example.test", {
      current_step_label: "Server truth",
    });
    expect(resolveStepLabel(serverLabel, steps)).toBe("Server truth");
    expect(resolveStepLabel(participant("linear@example.test"), steps)).toBe(
      "Email · Offer",
    );
    expect(
      resolveStepLabel(participant("branch@example.test"), [
        ...steps,
        { id: "branch", type: "condition", position: 4 },
      ]),
    ).toBeNull();
  });

  it("keeps a controller/presentation boundary and removes its ratchet", () => {
    const source = readFileSync(
      "src/components/sequence/SequenceParticipantsDrawer.tsx",
      "utf8",
    );
    expect(source).toContain("useSequenceParticipantsController");
    expect(source).toContain("SequenceParticipantsPresentation");
    expect(source).toMatch(
      /const controller = useSequenceParticipantsController\(\{/,
    );
    const budgets = readFileSync(
      "scripts/function-quality-budgets.json",
      "utf8",
    );
    expect(budgets).not.toContain(
      '"src/components/sequence/SequenceParticipantsDrawer.tsx"',
    );
  });
});
