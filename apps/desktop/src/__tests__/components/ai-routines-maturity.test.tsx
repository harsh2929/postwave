// @vitest-environment happy-dom

import axe from "axe-core";
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
  listRoutines: vi.fn(),
  createRoutine: vi.fn(),
  updateRoutine: vi.fn(),
  removeRoutine: vi.fn(),
  runRoutine: vi.fn(),
  listRuns: vi.fn(),
  listSegments: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
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
  useCanWrite: () => mocks.canWrite,
}));

vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopSectionResource: mocks.navigate,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../components/ai/AgentTrustPanel", () => ({
  AgentTrustPanel: () => <div>Verified run detail</div>,
  agentRunHasTrust: () => false,
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
  mocks.canWrite = true;
  for (const value of Object.values(mocks)) {
    if (typeof value === "function" && "mockReset" in value) value.mockReset();
  }
  mocks.listRoutines.mockResolvedValue({ data: { items: [] } });
  mocks.createRoutine.mockResolvedValue({ data: routine() });
  mocks.updateRoutine.mockResolvedValue({ data: routine() });
  mocks.removeRoutine.mockResolvedValue({ data: undefined });
  mocks.runRoutine.mockResolvedValue({
    data: { run_id: "run-1", status: "running" },
  });
  mocks.listRuns.mockResolvedValue({ data: { items: [] } });
  mocks.listSegments.mockResolvedValue({ data: [] });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.useRealTimers();
});

function routine(overrides: Record<string, unknown> = {}) {
  return {
    id: "routine-1",
    name: "Lifecycle brief",
    prompt: "Draft a lifecycle campaign.",
    kind: "draft_campaign",
    schedule: "weekly",
    target_segment_id: null,
    require_approval: true,
    enabled: true,
    has_active_run: false,
    last_run_at: null,
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-01T10:00:00Z",
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    routine_id: "routine-1",
    status: "failed",
    started_at: "2026-08-01T10:00:00Z",
    finished_at: "2026-08-01T10:01:00Z",
    ...overrides,
  };
}

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
): void {
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

function escape(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

function seriousViolations(result: axe.AxeResults): axe.Result[] {
  return result.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
}

function expectFocusableUnavailable(
  control: HTMLButtonElement,
  description: string,
): void {
  expect(control.disabled).toBe(false);
  expect(control.getAttribute("aria-disabled")).toBe("true");
  expect(control.getAttribute("title")).toBeNull();
  const descriptionIds =
    control.getAttribute("aria-describedby")?.split(/\s+/u) ?? [];
  expect(descriptionIds).not.toHaveLength(0);
  expect(
    descriptionIds
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" "),
  ).toContain(description);
  act(() => control.focus());
  expect(document.activeElement).toBe(control);
}

describe("Moosewave AI routine maturity", () => {
  it("locks every routine mutation while a durable run is active and keeps history available", async () => {
    mocks.listRoutines.mockResolvedValue({
      data: { items: [routine({ has_active_run: true })] },
    });
    mocks.listRuns.mockResolvedValue({
      data: { items: [run({ status: "running", finished_at: null })] },
    });
    render(<RoutinesPanel />);
    await settle();

    expect(document.body.textContent).toContain("Draft in progress");
    for (const label of ["Run now", "Pause interval", "Edit", "Delete"]) {
      const control = button(label);
      expectFocusableUnavailable(control, "run is active");
      act(() => control.click());
    }
    expect(mocks.runRoutine).not.toHaveBeenCalled();
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
    expect(mocks.removeRoutine).not.toHaveBeenCalled();

    expect(button("Run history").disabled).toBe(false);
    act(() => button("Run history").click());
    await settle();
    expect(mocks.listRuns).toHaveBeenCalledWith("routine-1");
    expect(document.body.textContent).toContain("Drafting");
  });

  it("surfaces a typed active-run conflict without provider detail or a second start", async () => {
    const secret = "provider quota account=customer-secret";
    mocks.listRoutines
      .mockResolvedValueOnce({ data: { items: [routine()] } })
      .mockResolvedValue({
        data: { items: [routine({ has_active_run: true })] },
      });
    mocks.runRoutine.mockResolvedValue({
      error: { status: 409, code: "routine_active", message: secret },
    });
    render(<RoutinesPanel />);
    await settle();

    act(() => button("Run now").click());
    await settle();

    expect(mocks.runRoutine).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "A draft is already running for this routine. Open run history to monitor it.",
    );
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(secret);
    expectFocusableUnavailable(button("Run now"), "run is active");
  });

  it("uses the canonical permission gate for every mutation while keeping review available", async () => {
    mocks.canWrite = false;
    mocks.listRoutines.mockResolvedValue({ data: { items: [routine()] } });
    render(<RoutinesPanel />);
    await settle();

    expect(document.body.textContent).toContain("Read-only viewer");
    expect(document.body.textContent).toContain(
      "Creating, editing, deleting, pausing or resuming interval schedules, and Run now are unavailable",
    );
    for (const label of [
      "+ New routine",
      "Run now",
      "Pause interval",
      "Edit",
      "Delete",
    ]) {
      const control = button(label);
      expectFocusableUnavailable(control, "unavailable for this role");
      act(() => control.click());
    }
    expect(mocks.createRoutine).not.toHaveBeenCalled();
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
    expect(mocks.removeRoutine).not.toHaveBeenCalled();
    expect(mocks.runRoutine).not.toHaveBeenCalled();

    expect(button("Run history").disabled).toBe(false);
    act(() => button("Run history").click());
    await settle();
    expect(mocks.listRuns).toHaveBeenCalledWith("routine-1");
    expect(document.body.textContent).toContain("No runs recorded");
  });

  it("states draft, approval, and interval behavior exactly as configured", async () => {
    mocks.listRoutines.mockResolvedValue({
      data: {
        items: [
          routine(),
          routine({
            id: "routine-2",
            name: "Draft without approval",
            require_approval: false,
            schedule: "monthly",
            enabled: false,
          }),
          routine({
            id: "routine-3",
            name: "Manual drafting brief",
            schedule: "manual",
            enabled: false,
          }),
        ],
      },
    });
    render(<RoutinesPanel />);
    await settle();

    expect(document.body.textContent).toContain("Approval request on");
    expect(document.body.textContent).toContain("No approval request");
    expect(document.body.textContent).toContain(
      "Every 30 days after a run starts",
    );
    expect(document.body.textContent).toContain(
      "First interval run eligible now",
    );
    expect(document.body.textContent).toContain(
      "First interval run eligible when enabled",
    );
    expect(document.body.textContent).toContain(
      "With no prior run, an enabled interval routine is eligible immediately",
    );
    const manualCard = Array.from(document.querySelectorAll("article")).find(
      (candidate) => candidate.textContent?.includes("Manual drafting brief"),
    );
    expect(manualCard?.textContent).toContain("Manual only");
    expect(manualCard?.textContent).not.toContain("Schedule paused");
    expect(manualCard?.textContent).not.toContain("Pause interval");
    expect(manualCard?.textContent).not.toContain("Resume interval");

    const editButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((candidate) => candidate.textContent?.trim() === "Edit");
    act(() => editButtons[1]?.click());
    await settle();
    let dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(
      document.querySelector<HTMLInputElement>("#routine-require-approval")
        ?.checked,
    ).toBe(false);
    expect(
      document.querySelector<HTMLSelectElement>("#routine-schedule")?.value,
    ).toBe("monthly");
    expect(dialog?.textContent).toContain(
      "A successful run creates a draft only. This routine creates an approval request only when the option below is on; it never sends.",
    );
    expect(dialog?.textContent).toContain(
      "When off, no approval request is created; the output remains a draft",
    );
    expect(dialog?.textContent).toContain(
      "If there is no prior run, an enabled interval routine is eligible on the next scheduler scan.",
    );
    expect(dialog?.textContent).not.toContain("Every draft goes to Approvals");

    act(() => button("Cancel").click());
    act(() => button("+ New routine").click());
    await settle();
    dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(
      document.querySelector<HTMLInputElement>("#routine-require-approval")
        ?.checked,
    ).toBe(true);
    const automatic =
      document.querySelector<HTMLInputElement>("#routine-enabled");
    expect(automatic?.checked).toBe(true);
    expect(automatic?.disabled).toBe(true);
    expect(dialog?.textContent).toContain(
      "Manual is Run now only. Choose an interval to configure automatic eligibility.",
    );
    const nameField = document.querySelector<HTMLInputElement>("#routine-name");
    const promptField =
      document.querySelector<HTMLTextAreaElement>("#routine-prompt");
    expect(nameField?.maxLength).toBe(400);
    expect(promptField?.maxLength).toBe(16_000);
    if (!nameField) throw new Error("Missing routine name field");
    setInput(nameField, "😀".repeat(200));
    expect(
      document.querySelector("#routine-name-count")?.textContent,
    ).toContain("200 / 200");
    expect(nameField.getAttribute("aria-invalid")).toBeNull();
    setInput(nameField, "😀".repeat(201));
    expect(nameField.getAttribute("aria-invalid")).toBe("true");
  });

  it("never renders raw API or stored run diagnostics", async () => {
    const secret =
      "pq: relation tenant_agent_keys does not exist at /internal/run";
    mocks.listRoutines.mockResolvedValueOnce({
      error: { status: 500, code: "internal", message: secret },
    });
    render(<RoutinesPanel />);
    await settle();

    expect(document.body.textContent).toContain(
      "The routines service couldn't complete the request.",
    );
    expect(document.body.textContent).not.toContain(secret);

    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.body.replaceChildren();
    mocks.listRoutines.mockResolvedValue({ data: { items: [routine()] } });
    mocks.runRoutine.mockResolvedValue({
      error: { status: 500, code: "internal", message: secret },
    });
    mocks.listRuns.mockResolvedValue({
      data: { items: [run({ error: secret })] },
    });
    render(<RoutinesPanel />);
    await settle();

    act(() => button("Run now").click());
    await settle();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "The routines service couldn't complete the request. Retry when ready.",
    );
    act(() => button("Run history").click());
    await settle();
    expect(document.body.textContent).toContain(
      "The draft couldn't be completed. Retry the routine when ready.",
    );
    expect(document.body.textContent).not.toContain(secret);
  });

  it("protects dirty drafts across Cancel, Escape, and backdrop dismissal", async () => {
    render(<RoutinesPanel />);
    await settle();
    act(() => button("+ New routine").click());
    await settle();

    const name = document.querySelector<HTMLInputElement>("#routine-name");
    if (!name) throw new Error("Missing routine name field");
    expect(document.activeElement).toBe(name);
    const editor = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!editor) throw new Error("Missing routine editor dialog");
    expect(
      seriousViolations(
        await axe.run(editor, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);
    setInput(name, "Unsaved lifecycle brief");
    expect(document.body.textContent).toContain("Unsaved changes");

    act(() => button("Cancel").click());
    const discardDecision = document.querySelector<HTMLElement>(
      '[role="alertdialog"]',
    );
    expect(discardDecision).not.toBeNull();
    expect(
      seriousViolations(
        await axe.run(discardDecision!, {
          rules: { region: { enabled: false } },
        }),
      ),
    ).toEqual([]);
    expect(document.activeElement).toBe(button("Keep editing"));
    act(() => button("Keep editing").click());
    await settle();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.querySelector("#routine-name")).not.toBeNull();

    escape();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    escape();
    await settle();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.querySelector("#routine-name")).not.toBeNull();

    const editorBackdrop =
      document.querySelector<HTMLElement>(".modal-backdrop");
    act(() => {
      editorBackdrop?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    act(() => button("Discard changes").click());
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector("#routine-name")).toBeNull();
  });

  it("surfaces polling expiry and lets the operator resume deliberately", async () => {
    vi.useFakeTimers();
    mocks.listRoutines.mockResolvedValue({ data: { items: [routine()] } });
    let runReads = 0;
    mocks.listRuns.mockImplementation(() => {
      runReads += 1;
      return Promise.resolve({
        data: {
          items: [
            run({
              status: runReads <= 21 ? "running" : "succeeded",
              finished_at: runReads <= 21 ? null : "2026-08-01T10:01:00Z",
              output_kind: runReads <= 21 ? undefined : "campaign",
              output_ref: runReads <= 21 ? undefined : "campaign-1",
              error: undefined,
            }),
          ],
        },
      });
    });
    render(<RoutinesPanel />);
    await settle();
    act(() => button("Run history").click());
    await settle();

    expect(document.body.textContent).toContain(
      "Checking automatically for about one minute",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.listRuns).toHaveBeenCalledTimes(21);
    expect(document.body.textContent).toContain(
      "Automatic checks paused after about one minute; the server-side run may still finish.",
    );

    act(() => button("Refresh runs").click());
    await settle();
    expect(mocks.listRuns).toHaveBeenCalledTimes(22);
    expect(document.body.textContent).toContain(
      "Run history is up to date for this refresh.",
    );
    expect(document.body.textContent).toContain("Draft created");
  });
});
