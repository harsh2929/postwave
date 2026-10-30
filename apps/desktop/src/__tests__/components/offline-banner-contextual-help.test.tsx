// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OfflineBanner } from "../../components/OfflineBanner";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  persistenceError: null as string | null,
  openHelp: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  flushQueuedMutations: vi.fn(),
}));

vi.mock("../../lib/help-launcher", () => ({
  requestContextualHelpOpen: mocks.openHelp,
}));

vi.mock("../../lib/online-manager", () => ({
  useConnectivity: () => ({
    status: "offline",
    reason: "proxy-tls",
    checkedAt: 1,
  }),
}));

vi.mock("../../lib/outbox", () => ({
  useOutbox: () => ({
    pendingCount: 0,
    attentionCount: 0,
    persistenceError: mocks.persistenceError,
  }),
}));

vi.mock("../../components/Toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.persistenceError = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function renderBanner(): void {
  act(() => root.render(<OfflineBanner />));
}

describe("OfflineBanner contextual help", () => {
  it("opens reason-specific recovery help without passing transport text", () => {
    renderBanner();
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Connection help",
    );

    act(() => button?.click());

    expect(mocks.openHelp).toHaveBeenCalledWith({
      task: "recovery",
      errorCode: "PROXY_TLS",
    });
  });

  it("keeps a critical persistence failure on its dedicated sync-journal path", () => {
    mocks.persistenceError = "private persistence detail";
    renderBanner();

    expect(container.textContent).toContain("Offline storage needs attention");
    expect(container.textContent).not.toContain("Connection help");
    expect(container.textContent).not.toContain("private persistence detail");
  });
});
