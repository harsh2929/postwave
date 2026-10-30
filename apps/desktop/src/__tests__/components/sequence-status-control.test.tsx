// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import axe from "axe-core";
import { act, type ReactNode } from "react";
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

import type { Sequence } from "../../lib/api-client";
import { popDialog, pushDialog } from "../../lib/dialogStack";
import type { SequenceMutationEnqueuer } from "../../components/sequence/useSequenceStatusController";

const mocks = vi.hoisted(() => ({
  onChange: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  updateSequence: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { updateSequence: mocks.updateSequence },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("../../components/Modal", () => ({
  Modal: ({
    children,
    description,
    open,
    title,
  }: {
    children: ReactNode;
    description?: ReactNode;
    open: boolean;
    title: string;
  }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        <h2>{title}</h2>
        <p>{description}</p>
        {children}
      </section>
    ) : null,
  ModalFooter: ({ children }: { children: ReactNode }) => (
    <footer>{children}</footer>
  ),
}));

import { SequenceStatusControl } from "../../components/sequence/SequenceStatusControl";

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

function sequence(overrides: Partial<Sequence> = {}): Sequence {
  return {
    id: "sequence/one",
    name: "Welcome flow",
    status: "active",
    active_runs: 3,
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let currentProps: {
  sequence: Sequence;
  canMutate: boolean;
  runtimeAvailable: boolean;
  versionRef?: { current: number | null };
  enqueueMutation?: SequenceMutationEnqueuer;
};

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  mocks.updateSequence.mockResolvedValue({
    data: { status: "active", version: 2 },
  });
  currentProps = {
    sequence: sequence(),
    canMutate: true,
    runtimeAvailable: true,
    versionRef: { current: 1 },
  };
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function renderControl(overrides: Partial<typeof currentProps> = {}): void {
  currentProps = { ...currentProps, ...overrides };
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.appendChild(container);
  root ??= createRoot(container);
  act(() =>
    root?.render(
      <SequenceStatusControl
        sequence={currentProps.sequence}
        canMutate={currentProps.canMutate}
        runtimeAvailable={currentProps.runtimeAvailable}
        versionRef={currentProps.versionRef}
        enqueueMutation={currentProps.enqueueMutation}
        onChange={mocks.onChange}
      />,
    ),
  );
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

function statusItem(label: string): HTMLButtonElement {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
  ).find((candidate) => candidate.textContent?.trim().startsWith(label));
  expect(found).toBeDefined();
  return found!;
}

function trigger(): HTMLButtonElement {
  const found = container?.querySelector<HTMLButtonElement>(
    'button[aria-haspopup="menu"]',
  );
  expect(found).not.toBeNull();
  return found!;
}

function setArchiveName(value: string): void {
  const input = container?.querySelector<HTMLInputElement>(
    "#seq-archive-confirm",
  );
  expect(input).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SequenceStatusControl mutation boundaries", () => {
  it("defaults closed and presents a truthful non-interactive legacy status", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <SequenceStatusControl
          sequence={sequence()}
          canMutate
          onChange={mocks.onChange}
        />,
      );
    });

    expect(container.querySelector('button[aria-haspopup="menu"]')).toBeNull();
    const status = container.querySelector<HTMLElement>(".badge");
    expect(status?.textContent).toBe("Legacy active label");
    expect(status?.getAttribute("aria-label")).toContain(
      "Live sequence triggers, enrollment, delivery, and runtime analytics are not available in this build.",
    );
    expect(status?.title).toContain("you cannot activate them");
    expect(mocks.updateSequence).not.toHaveBeenCalled();
  });

  it("fails closed for viewers and unsaved sequences, including an open-menu role downgrade", async () => {
    renderControl({ canMutate: false });
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(trigger().getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("Editor access");
    act(() => trigger().click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(mocks.updateSequence).not.toHaveBeenCalled();

    renderControl({ canMutate: true, sequence: sequence({ id: undefined }) });
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(trigger().getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("Save this sequence");

    renderControl({
      sequence: sequence(),
      canMutate: true,
      versionRef: { current: null },
    });
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(trigger().getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("confirm its current version");

    renderControl({
      sequence: sequence(),
      canMutate: true,
      versionRef: { current: 1 },
    });
    act(() => trigger().click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    renderControl({ canMutate: false });
    await flushEffects();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(mocks.updateSequence).not.toHaveBeenCalled();
  });

  it("serializes an exact direct resume and propagates the server version", async () => {
    const request = deferred<{
      data: { status: string; version: number };
    }>();
    const versionRef = { current: 7 as number | null };
    mocks.updateSequence.mockReturnValue(request.promise);
    renderControl({
      sequence: sequence({ status: "paused" }),
      versionRef,
    });
    act(() => trigger().click());
    const active = statusItem("Active");
    act(() => {
      active.click();
      active.click();
    });

    expect(mocks.updateSequence).toHaveBeenCalledTimes(1);
    expect(mocks.updateSequence).toHaveBeenCalledWith(
      "sequence/one",
      { status: "active" },
      7,
    );
    expect(mocks.onChange).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "sequence/one", status: "active" }),
    );
    expect(trigger().getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      request.resolve({ data: { status: "active", version: 8 } });
      await request.promise;
    });
    expect(versionRef.current).toBe(8);
    expect(mocks.onChange).toHaveBeenCalledTimes(2);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Sequence activated");
  });

  it("joins the canvas mutation queue and reads its version only when the queued task runs", async () => {
    const queueGate = deferred<void>();
    const versionRef = { current: 7 as number | null };
    const enqueueCall = vi.fn();
    const enqueueMutation: SequenceMutationEnqueuer = async <T,>(
      task: () => Promise<T>,
    ) => {
      enqueueCall(task);
      await queueGate.promise;
      return task();
    };
    mocks.updateSequence.mockResolvedValue({
      data: { status: "active", version: 9 },
    });
    renderControl({
      sequence: sequence({ status: "paused" }),
      versionRef,
      enqueueMutation,
    });

    act(() => trigger().click());
    act(() => statusItem("Active").click());
    expect(enqueueCall).toHaveBeenCalledTimes(1);
    expect(mocks.updateSequence).not.toHaveBeenCalled();

    versionRef.current = 8;
    await act(async () => {
      queueGate.resolve(undefined);
      await queueGate.promise;
    });
    await flushEffects();

    expect(mocks.updateSequence).toHaveBeenCalledWith(
      "sequence/one",
      { status: "active" },
      8,
    );
    expect(versionRef.current).toBe(9);
  });

  it("invalidates mutation authority when success does not confirm the exact next version", async () => {
    const versionRef = { current: 3 as number | null };
    mocks.updateSequence.mockResolvedValue({
      data: { status: "draft", version: 3 },
    });
    renderControl({
      sequence: sequence({ status: "paused" }),
      versionRef,
    });

    act(() => trigger().click());
    act(() => statusItem("Draft").click());
    await flushEffects();

    expect(mocks.updateSequence).toHaveBeenCalledWith(
      "sequence/one",
      { status: "draft" },
      3,
    );
    expect(versionRef.current).toBeNull();
    expect(mocks.onChange).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: "draft" }),
    );
    expect(mocks.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "paused" }),
    );
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringMatching(/did not confirm the next sequence version/i),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("confirms pause once and rolls an optimistic transition back on a 412", async () => {
    const request = deferred<{
      error: { code: string; message: string };
    }>();
    mocks.updateSequence.mockReturnValue(request.promise);
    renderControl();
    act(() => trigger().click());
    act(() => statusItem("Paused").click());
    expect(container?.querySelector('[role="dialog"]')?.textContent).toContain(
      "3 active runs will be held",
    );
    const confirm = button("Pause sequence");
    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(mocks.updateSequence).toHaveBeenCalledTimes(1);
    expect(mocks.updateSequence).toHaveBeenCalledWith(
      "sequence/one",
      { status: "paused" },
      1,
    );
    expect(mocks.onChange).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: "paused" }),
    );

    await act(async () => {
      request.resolve({
        error: { code: "precondition_failed", message: "stale" },
      });
      await request.promise;
    });
    expect(mocks.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "active" }),
    );
    expect(mocks.toastError).toHaveBeenCalledWith(
      "This sequence was edited in another tab — refresh to see the latest version, then re-apply your change.",
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("requires an exact archive name and gives unnamed sequences a usable confirmation", async () => {
    renderControl({ sequence: sequence({ status: "draft" }) });
    act(() => trigger().click());
    act(() => statusItem("Archived").click());
    setArchiveName("welcome flow");
    expect(button("Archive sequence").disabled).toBe(false);
    expect(button("Archive sequence").getAttribute("aria-disabled")).toBe(
      "true",
    );
    setArchiveName("Welcome flow");
    expect(button("Archive sequence").disabled).toBe(false);
    expect(button("Archive sequence").getAttribute("aria-disabled")).toBeNull();
    act(() => button("Archive sequence").click());
    await flushEffects();
    expect(mocks.updateSequence).toHaveBeenCalledWith(
      "sequence/one",
      { status: "archived" },
      1,
    );

    act(() => root?.unmount());
    root = null;
    container?.replaceChildren();
    mocks.updateSequence.mockClear();
    renderControl({ sequence: sequence({ name: "", status: "draft" }) });
    act(() => trigger().click());
    act(() => statusItem("Archived").click());
    expect(
      container?.querySelector<HTMLInputElement>("#seq-archive-confirm")
        ?.placeholder,
    ).toBe("ARCHIVE");
    setArchiveName("ARCHIVE");
    act(() => button("Archive sequence").click());
    await flushEffects();
    expect(mocks.updateSequence).toHaveBeenCalledTimes(1);
  });

  it("suppresses completions after a sequence switch and after unmount", async () => {
    const oldRequest = deferred<{
      data: { status: string; version: number };
    }>();
    const nextRequest = deferred<{
      data: { status: string; version: number };
    }>();
    const versionRef = { current: 4 as number | null };
    mocks.updateSequence
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(nextRequest.promise);
    renderControl({
      sequence: sequence({ status: "paused" }),
      versionRef,
    });
    act(() => trigger().click());
    act(() => statusItem("Draft").click());
    expect(mocks.onChange).toHaveBeenCalledTimes(1);

    renderControl({
      sequence: sequence({ id: "sequence/two", status: "paused" }),
    });
    await flushEffects();
    await act(async () => {
      oldRequest.resolve({ data: { status: "draft", version: 99 } });
      await oldRequest.promise;
    });
    expect(mocks.onChange).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(versionRef.current).toBe(4);

    act(() => trigger().click());
    act(() => statusItem("Draft").click());
    expect(mocks.updateSequence).toHaveBeenCalledTimes(2);
    expect(mocks.onChange).toHaveBeenCalledTimes(2);
    act(() => root?.unmount());
    root = null;
    await act(async () => {
      nextRequest.resolve({ data: { status: "draft", version: 5 } });
      await nextRequest.promise;
    });
    expect(mocks.onChange).toHaveBeenCalledTimes(2);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(versionRef.current).toBe(4);
  });
});

describe("SequenceStatusControl accessibility and quality", () => {
  it("normalizes running and supports the complete radio-menu focus contract", async () => {
    renderControl({ sequence: sequence({ status: "running" }) });
    expect(trigger().getAttribute("aria-label")).toContain("Active");
    act(() => trigger().click());
    const menu = document.querySelector<HTMLDivElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.parentElement).toBe(document.body);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(menu?.id);
    expect(menu?.getAttribute("aria-labelledby")).toBe(trigger().id);
    const active = statusItem("Active");
    const paused = statusItem("Paused");
    const draft = statusItem("Draft");
    const archived = statusItem("Archived");
    expect(active.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(active);
    expect(
      [active, paused, draft, archived].filter(
        (item) => item.getAttribute("tabindex") === "0",
      ),
    ).toEqual([active]);

    act(() => {
      active.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(paused);
    expect(paused.tabIndex).toBe(0);
    expect(active.tabIndex).toBe(-1);
    act(() => {
      paused.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(archived);

    const composingArrow = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
    });
    Object.defineProperty(composingArrow, "isComposing", { value: true });
    act(() => {
      archived.dispatchEvent(composingArrow);
    });
    expect(document.activeElement).toBe(archived);

    act(() => {
      archived.dispatchEvent(
        new KeyboardEvent("keydown", { key: "d", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(draft);

    const composingEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    });
    Object.defineProperty(composingEscape, "keyCode", { value: 229 });
    act(() => {
      draft.dispatchEvent(composingEscape);
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    act(() => pushDialog("nested-sequence-surface"));
    act(() => {
      draft.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    act(() => popDialog("nested-sequence-surface"));

    act(() => {
      draft.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await act(async () => Promise.resolve());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps popup ownership instance-safe", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <>
          <SequenceStatusControl
            sequence={sequence({ id: "sequence/one" })}
            canMutate
            runtimeAvailable
            versionRef={{ current: 1 }}
            onChange={mocks.onChange}
          />
          <SequenceStatusControl
            sequence={sequence({ id: "sequence/two" })}
            canMutate
            runtimeAvailable
            versionRef={{ current: 1 }}
            onChange={mocks.onChange}
          />
        </>,
      );
    });
    const triggers = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[aria-haspopup="menu"]',
      ),
    );
    expect(triggers).toHaveLength(2);
    expect(triggers[0]?.id).not.toBe(triggers[1]?.id);
    act(() => triggers[0]?.click());
    expect(triggers[0]?.getAttribute("aria-controls")).not.toBeNull();
    expect(triggers[0]?.getAttribute("aria-controls")).not.toBe(
      triggers[1]?.getAttribute("aria-controls"),
    );
  });

  it("closes on Tab, outside pointer, and focus departure without stealing focus", () => {
    renderControl();
    act(() => trigger().click());
    act(() => {
      statusItem("Active").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();

    act(() => trigger().click());
    act(() => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => trigger().click());
    act(() => outside.focus());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("flips and clamps its portal inside a compact viewport", () => {
    renderControl();
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(320);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(240);
    vi.spyOn(trigger(), "getBoundingClientRect").mockReturnValue({
      bottom: 204,
      height: 24,
      left: 290,
      right: 310,
      top: 180,
      width: 20,
      x: 290,
      y: 180,
      toJSON: () => ({}),
    });
    act(() => trigger().click());
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu?.style.position).toBe("fixed");
    expect(menu?.style.left).toBe("32px");
    expect(menu?.style.bottom).toBe("66px");
    expect(menu?.style.top).toBe("");
    expect(menu?.style.maxHeight).toBe("166px");
    expect(menu?.style.overflowY).toBe("auto");
  });

  it("has no serious automated accessibility violations while expanded", async () => {
    renderControl();
    act(() => trigger().click());
    const result = await axe.run(document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("keeps the controller boundary and removes the legacy ratchet", () => {
    const source = readFileSync(
      "src/components/sequence/SequenceStatusControl.tsx",
      "utf8",
    );
    expect(source).toContain("useSequenceStatusController");
    expect(source).toContain("useStatusMenuInteractions");
    const budgets = readFileSync(
      "scripts/function-quality-budgets.json",
      "utf8",
    );
    expect(budgets).not.toContain(
      '"src/components/sequence/SequenceStatusControl.tsx"',
    );
  });
});
