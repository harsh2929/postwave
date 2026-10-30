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

const recovery = vi.hoisted(() => ({
  copy: vi.fn<() => Promise<{ ok: true }>>(),
  restart: vi.fn<() => Promise<void>>(),
  safeMode: vi.fn<() => Promise<void>>(),
  web: vi.fn<() => Promise<void>>(),
  support: vi.fn<() => Promise<void>>(),
}));

vi.mock("../../lib/desktop-recovery", () => ({
  copyDesktopDiagnostics: recovery.copy,
  restartDesktopApp: recovery.restart,
  restartDesktopInSafeMode: recovery.safeMode,
  openDesktopWebApp: recovery.web,
  openDesktopSupport: recovery.support,
}));

import { ErrorScreen } from "../../components/ErrorScreen";

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
  recovery.copy.mockReset().mockResolvedValue({ ok: true });
  recovery.restart.mockReset().mockResolvedValue(undefined);
  recovery.safeMode.mockReset().mockResolvedValue(undefined);
  recovery.web.mockReset().mockResolvedValue(undefined);
  recovery.support.mockReset().mockResolvedValue(undefined);
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

function button(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ErrorScreen recovery contract", () => {
  it("shows an incident and complete recovery paths without exposing the error", async () => {
    const secret = "Bearer pw_live_never-render user@example.test";
    render(
      <ErrorScreen
        error={new Error(secret)}
        incident={{
          incidentId: "PW-20260716-A1B2C3D4E5",
          occurredAtMs: 1,
          kind: "renderer_boundary",
          errorType: "Error",
          errorCode: null,
          componentTrace: ["CampaignEditor"],
        }}
        onRetry={vi.fn()}
      />,
    );

    expect(document.body.textContent).toContain("PW-20260716-A1B2C3D4E5");
    expect(document.body.textContent).not.toContain(secret);
    for (const label of [
      "Try this screen again",
      "Restart App",
      "Restart in Safe Mode",
      "Copy diagnostics",
      "Open Web App",
      "Support",
    ]) {
      expect(button(label)).toBeTruthy();
    }

    await click("Copy diagnostics");
    expect(recovery.copy).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "excludes messages",
    );
  });

  it("routes restart, Safe Mode, web, and support through contained async actions", async () => {
    render(<ErrorScreen error={new Error("failure")} />);

    await click("Restart App");
    await click("Restart in Safe Mode");
    await click("Open Web App");
    await click("Support");

    expect(recovery.restart).toHaveBeenCalledTimes(1);
    expect(recovery.safeMode).toHaveBeenCalledTimes(1);
    expect(recovery.web).toHaveBeenCalledTimes(1);
    expect(recovery.support).toHaveBeenCalledTimes(1);
  });
});
