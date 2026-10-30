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

import type { DesktopUpdateState } from "../../lib/desktop-update-service";

const mocks = vi.hoisted(() => ({
  state: {} as DesktopUpdateState,
  check: vi.fn(),
  clearReminder: vi.fn(),
  defer: vi.fn(),
  install: vi.fn(),
  restart: vi.fn(),
  retry: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("../../lib/desktop-update-service", () => ({
  checkForDesktopUpdate: mocks.check,
  clearDesktopUpdateReminder: mocks.clearReminder,
  deferDesktopUpdate: mocks.defer,
  installDesktopUpdate: mocks.install,
  requestDesktopUpdateRestart: mocks.restart,
  retryDesktopUpdate: mocks.retry,
  useDesktopUpdateState: () => mocks.state,
}));

vi.mock("../../components/Toast", () => ({
  toast: { info: mocks.toastInfo },
}));

import { DesktopUpdateSettings } from "../../components/settings/DesktopUpdateSettings";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of [
    mocks.check,
    mocks.clearReminder,
    mocks.defer,
    mocks.install,
    mocks.restart,
    mocks.retry,
    mocks.toastInfo,
  ]) {
    mock.mockReset();
  }
  mocks.state = updateState();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("DesktopUpdateSettings", () => {
  it("presents signed release metadata, plain-text notes, install, and reminders", () => {
    render(<DesktopUpdateSettings />);
    expect(document.body.textContent).toContain("Version 1.1.0 is available");
    expect(document.body.textContent).toContain("Important");
    expect(document.body.textContent).toContain(
      "Reliability and security fixes.",
    );
    expect(document.body.textContent).toContain("automatically");

    act(() => button("Install v1.1.0").click());
    expect(mocks.install).toHaveBeenCalledTimes(1);
    act(() => button("Remind in 4 hours").click());
    expect(mocks.defer).toHaveBeenCalledWith(4 * 60 * 60 * 1000);
  });

  it("exposes determinate progress semantics during download", () => {
    mocks.state = updateState({
      phase: "downloading",
      downloadedBytes: 512,
      totalBytes: 1024,
    });
    render(<DesktopUpdateSettings />);
    const progress = document.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute("aria-valuenow")).toBe("50");
    expect(progress?.getAttribute("aria-valuetext")).toBe("50% downloaded");
    expect(document.body.textContent).toContain("50%");
  });

  it("keeps failed installs retryable and labels the error", () => {
    mocks.state = updateState({
      phase: "error",
      error: "signature download timed out",
      lastFailedOperation: "install",
    });
    render(<DesktopUpdateSettings />);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "signature download timed out",
    );
    act(() => button("Retry installation").click());
    expect(mocks.retry).toHaveBeenCalledTimes(1);
  });

  it("routes restart through the global safety decision and supports later", () => {
    mocks.state = updateState({ phase: "ready_to_restart" });
    render(<DesktopUpdateSettings />);
    act(() => button("Review & restart").click());
    expect(mocks.restart).toHaveBeenCalledTimes(1);
    act(() => button("Restart later").click());
    expect(mocks.defer).toHaveBeenCalledWith(4 * 60 * 60 * 1000);
  });
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.includes(label));
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function updateState(
  overrides: Partial<DesktopUpdateState> = {},
): DesktopUpdateState {
  return {
    initialized: true,
    phase: "available",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    severity: "important",
    releaseNotes: "Reliability and security fixes.",
    publishedAt: "2026-07-16T08:00:00Z",
    lastCheckedAt: 1_752_652_800_000,
    checkSource: "scheduled",
    error: null,
    lastFailedOperation: null,
    downloadedBytes: 0,
    totalBytes: null,
    snoozedUntil: null,
    lastPromptedVersion: null,
    lastPromptedAt: null,
    restartDecision: null,
    restarting: false,
    ...overrides,
  };
}
