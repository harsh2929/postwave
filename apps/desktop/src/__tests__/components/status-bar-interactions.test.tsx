// @vitest-environment happy-dom

import axe from "axe-core";
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

const mocks = vi.hoisted(() => ({
  attentionCount: 2,
  connection: "online" as "online" | "offline" | "connecting",
  getAppVersion: vi.fn(),
  pendingCount: 3,
  startOnlineManager: vi.fn(),
  stopOnlineManager: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  getApiUrl: () => "https://api.example.test",
}));
vi.mock("../../lib/online-manager", () => ({
  useOnline: () => mocks.connection,
  startOnlineManager: mocks.startOnlineManager,
}));
vi.mock("../../lib/outbox", () => ({
  useOutbox: () => ({
    pendingCount: mocks.pendingCount,
    attentionCount: mocks.attentionCount,
  }),
}));
vi.mock("../../lib/tauri", () => ({
  tauriApi: { getAppVersion: mocks.getAppVersion },
}));
vi.mock("../../components/dashboard/ActiveSendStrip", () => ({
  ActiveSendStrip: () => null,
}));
vi.mock("../../components/QueueTray", () => ({
  QueueTray: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Offline changes">
      <button type="button" onClick={onClose}>
        Close queue
      </button>
    </div>
  ),
}));

import { StatusBar } from "../../components/StatusBar";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.attentionCount = 2;
  mocks.connection = "online";
  mocks.pendingCount = 3;
  mocks.getAppVersion.mockReset();
  mocks.startOnlineManager.mockReset();
  mocks.stopOnlineManager.mockReset();
  mocks.startOnlineManager.mockReturnValue(mocks.stopOnlineManager);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function renderStatusBar(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<StatusBar />));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
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

describe("StatusBar interactions", () => {
  it("names queue actions visibly and exposes the tray relationship", async () => {
    mocks.getAppVersion.mockResolvedValue({ version: "3.2.1" });
    renderStatusBar();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Moosewave v3.2.1"),
    );

    expect(
      document.querySelector('footer[aria-label="Application status"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Connected");
    expect(document.body.textContent).toContain("3 offline changes pending");
    expect(document.body.textContent).toContain(
      "2 offline changes need attention",
    );
    expect(document.querySelector("[title]")).toBeNull();

    const pending = button("3 offline changes pending");
    expect(pending.getAttribute("aria-haspopup")).toBe("dialog");
    expect(pending.getAttribute("aria-expanded")).toBe("false");
    act(() => pending.click());
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
    );
    expect(
      button("3 offline changes pending").getAttribute("aria-expanded"),
    ).toBe("true");

    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("contains native version failures and remains honest", async () => {
    mocks.pendingCount = 0;
    mocks.attentionCount = 0;
    mocks.connection = "offline";
    mocks.getAppVersion.mockRejectedValue(new Error("native unavailable"));
    renderStatusBar();

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Moosewave version unavailable",
      ),
    );
    expect(document.body.textContent).toContain("Disconnected");
    expect(document.body.textContent).not.toContain("0.1.0");
    expect(mocks.startOnlineManager).toHaveBeenCalledTimes(1);

    act(() => root?.unmount());
    root = null;
    expect(mocks.stopOnlineManager).toHaveBeenCalledTimes(1);
  });
});
