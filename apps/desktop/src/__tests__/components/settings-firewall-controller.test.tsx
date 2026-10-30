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

import type {
  FirewallEvent,
  FirewallSettings,
  FirewallStats,
} from "../../lib/api-client";
import {
  discardAndRecheckLifecycleTransition,
  getLifecycleDecisionState,
  inspectLifecycle,
  prepareLifecycle,
  requestLifecycleTransition,
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

const mocks = vi.hoisted(() => ({
  canAdmin: { value: true },
  detect: vi.fn(),
  events: vi.fn(),
  putSettings: vi.fn(),
  settings: vi.fn(),
  stats: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  firewallApi: {
    detect: mocks.detect,
    events: mocks.events,
    putSettings: mocks.putSettings,
    settings: mocks.settings,
    stats: mocks.stats,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin.value,
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import {
  type FirewallController,
  useFirewallController,
} from "../../components/settings/useFirewallController";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: FirewallController | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAdmin.value = true;
  mocks.settings.mockResolvedValue({ data: settings() });
  mocks.stats.mockResolvedValue({ data: stats() });
  mocks.events.mockResolvedValue({ data: { events: [event()], count: 1 } });
  mocks.putSettings.mockResolvedValue({ data: settings() });
  mocks.detect.mockResolvedValue({ data: { flipped: false } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  latest = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
  vi.clearAllMocks();
});

function settings(overrides: Partial<FirewallSettings> = {}): FirewallSettings {
  return {
    tenant_id: "tenant-1",
    attack_mode_enabled: false,
    auto_attack_mode: true,
    fingerprint_required: true,
    attack_mode_threshold: 70,
    surge_multiplier: 4,
    surge_min_per_hour: 100,
    updated_at: "2026-07-16T08:00:00.000Z",
    ...overrides,
  };
}

function stats(): FirewallStats {
  return {
    last_24h: { accepted: 8, rejected: 2, observed: 1 },
    last_7d: { accepted: 80, rejected: 20, observed: 10 },
  };
}

function event(): FirewallEvent {
  return {
    id: "event-1",
    form_id: "form-1",
    browser_fp_present: true,
    ua_quality: 1,
    referer_quality: 1,
    rate_5m: 2,
    risk_score: 91,
    action: "rejected",
    ip: "203.0.113.10",
    at: "2026-07-16T08:00:00.000Z",
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Probe(): ReactElement {
  const controller = useFirewallController();
  latest = controller;
  return (
    <div>
      <span data-testid="threshold">
        {controller.draft?.attack_mode_threshold}
      </span>
      <span data-testid="attack">
        {String(controller.draft?.attack_mode_enabled)}
      </span>
      <span data-testid="loading">{String(controller.loading)}</span>
      <span data-testid="dirty">{String(controller.dirty)}</span>
      <span data-testid="saving">{String(controller.saving)}</span>
      <span data-testid="detecting">{String(controller.detecting)}</span>
      <span data-testid="result">{controller.detectResult ?? "none"}</span>
      <span data-testid="error">{controller.error ?? "none"}</span>
    </div>
  );
}

function renderController(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Probe />));
}

function text(testId: string): string | null {
  return (
    document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
  );
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => Promise.resolve());
    }
  }
  throw lastError;
}

async function renderLoaded(): Promise<void> {
  renderController();
  await waitFor(() => expect(text("loading")).toBe("false"));
}

describe("firewall settings controller", () => {
  it("loads the exact bounded fanout and exposes server state", async () => {
    await renderLoaded();

    expect(mocks.settings).toHaveBeenCalledTimes(1);
    expect(mocks.stats).toHaveBeenCalledTimes(1);
    expect(mocks.events).toHaveBeenCalledWith({ limit: 20 });
    expect(text("threshold")).toBe("70");
    expect(latest?.events).toEqual([event()]);
    expect(latest?.stats).toEqual(stats());
  });

  it("keeps only the newest overlapping reload and its loading state", async () => {
    const oldSettings = deferred<{ data: FirewallSettings }>();
    const oldStats = deferred<{ data: FirewallStats }>();
    const oldEvents = deferred<{
      data: { events: FirewallEvent[]; count: number };
    }>();
    const newSettings = deferred<{ data: FirewallSettings }>();
    const newStats = deferred<{ data: FirewallStats }>();
    const newEvents = deferred<{
      data: { events: FirewallEvent[]; count: number };
    }>();
    mocks.settings
      .mockReset()
      .mockReturnValueOnce(oldSettings.promise)
      .mockReturnValueOnce(newSettings.promise);
    mocks.stats
      .mockReset()
      .mockReturnValueOnce(oldStats.promise)
      .mockReturnValueOnce(newStats.promise);
    mocks.events
      .mockReset()
      .mockReturnValueOnce(oldEvents.promise)
      .mockReturnValueOnce(newEvents.promise);
    renderController();
    act(() => void latest?.load());

    await act(async () => {
      oldSettings.resolve({ data: settings({ attack_mode_threshold: 10 }) });
      oldStats.resolve({ data: stats() });
      oldEvents.resolve({ data: { events: [], count: 0 } });
      await Promise.all([
        oldSettings.promise,
        oldStats.promise,
        oldEvents.promise,
      ]);
    });
    expect(text("threshold")).toBe("");
    expect(text("loading")).toBe("true");

    await act(async () => {
      newSettings.resolve({ data: settings({ attack_mode_threshold: 90 }) });
      newStats.resolve({ data: stats() });
      newEvents.resolve({ data: { events: [event()], count: 1 } });
      await Promise.all([
        newSettings.promise,
        newStats.promise,
        newEvents.promise,
      ]);
    });
    expect(text("threshold")).toBe("90");
    expect(text("loading")).toBe("false");
  });

  it("submits one exact partial patch and serializes double save", async () => {
    const pendingSave = deferred<{ data: FirewallSettings }>();
    mocks.putSettings.mockReturnValue(pendingSave.promise);
    await renderLoaded();
    act(() => latest?.setDraft({ attack_mode_threshold: 85 }));
    await waitFor(() => expect(text("dirty")).toBe("true"));

    act(() => {
      void latest?.save();
      void latest?.save();
    });
    expect(mocks.putSettings).toHaveBeenCalledTimes(1);
    expect(mocks.putSettings).toHaveBeenCalledWith({
      attack_mode_threshold: 85,
    });
    expect(text("saving")).toBe("true");

    await act(async () => {
      pendingSave.resolve({
        data: settings({ attack_mode_threshold: 85 }),
      });
      await pendingSave.promise;
    });
    expect(text("saving")).toBe("false");
    expect(text("dirty")).toBe("false");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Firewall settings saved");
  });

  it("preserves unsaved edits when a surge flip refreshes server state", async () => {
    mocks.settings
      .mockResolvedValueOnce({ data: settings() })
      .mockResolvedValueOnce({
        data: settings({ attack_mode_enabled: true }),
      });
    mocks.detect.mockResolvedValue({ data: { flipped: true } });
    await renderLoaded();
    act(() => latest?.setDraft({ attack_mode_threshold: 85 }));
    await waitFor(() => expect(text("dirty")).toBe("true"));

    await act(async () => {
      await latest?.detect();
    });
    expect(mocks.detect).toHaveBeenCalledTimes(1);
    expect(mocks.settings).toHaveBeenCalledTimes(2);
    expect(text("attack")).toBe("true");
    expect(text("threshold")).toBe("85");
    expect(text("dirty")).toBe("true");
    expect(text("result")).toContain("attack mode was enabled");
  });

  it("retains a dirty draft across an empty refresh and successful retry", async () => {
    await renderLoaded();
    act(() => latest?.setDraft({ attack_mode_threshold: 85 }));
    await waitFor(() => expect(text("dirty")).toBe("true"));
    mocks.settings.mockResolvedValueOnce({ data: undefined });

    await act(async () => {
      await latest?.load();
    });
    expect(text("error")).toContain("response was empty");
    expect(text("threshold")).toBe("85");
    expect(text("dirty")).toBe("true");

    mocks.settings.mockResolvedValueOnce({
      data: settings({ attack_mode_threshold: 75 }),
    });
    await act(async () => {
      await latest?.load();
    });
    expect(text("error")).toBe("none");
    expect(text("threshold")).toBe("85");
    expect(text("dirty")).toBe("true");
  });

  it("serializes detect against save through the shared mutation guard", async () => {
    const pendingDetect = deferred<{ data: { flipped: boolean } }>();
    mocks.detect.mockReturnValue(pendingDetect.promise);
    await renderLoaded();
    act(() => latest?.setDraft({ attack_mode_threshold: 85 }));
    await waitFor(() => expect(text("dirty")).toBe("true"));
    act(() => {
      void latest?.detect();
      void latest?.save();
    });

    expect(mocks.detect).toHaveBeenCalledTimes(1);
    expect(mocks.putSettings).not.toHaveBeenCalled();
    expect(text("detecting")).toBe("true");
    await act(async () => {
      pendingDetect.resolve({ data: { flipped: false } });
      await pendingDetect.promise;
    });
    expect(text("detecting")).toBe("false");
  });

  it("enforces admin mutation guards inside the controller", async () => {
    mocks.canAdmin.value = false;
    await renderLoaded();
    act(() => latest?.setDraft({ attack_mode_threshold: 85 }));
    await act(async () => {
      await latest?.save();
      await latest?.detect();
    });

    expect(text("threshold")).toBe("70");
    expect(mocks.putSettings).not.toHaveBeenCalled();
    expect(mocks.detect).not.toHaveBeenCalled();
  });

  it("fails honestly when the surge endpoint returns no result", async () => {
    mocks.detect.mockResolvedValue({ data: undefined });
    await renderLoaded();
    await act(async () => {
      await latest?.detect();
    });

    expect(text("result")).toBe("none");
    expect(text("detecting")).toBe("false");
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "Surge check failed",
      detail: "The server returned no surge result.",
    });
  });

  it("ignores a save response after unmount", async () => {
    const pendingSave = deferred<{ data: FirewallSettings }>();
    mocks.putSettings.mockReturnValue(pendingSave.promise);
    await renderLoaded();
    act(() => latest?.setDraft({ attack_mode_threshold: 85 }));
    await waitFor(() => expect(text("dirty")).toBe("true"));
    act(() => void latest?.save());
    const mountedRoot = root;
    act(() => mountedRoot?.unmount());
    root = null;

    await act(async () => {
      pendingSave.resolve({ data: settings({ attack_mode_threshold: 85 }) });
      await pendingSave.promise;
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("awaits lifecycle Save and explicitly discards to the acknowledged firewall baseline", async () => {
    const pendingSave = deferred<{ data: FirewallSettings }>();
    mocks.putSettings.mockReturnValueOnce(pendingSave.promise);
    await renderLoaded();
    act(() => latest?.setDraft({ attack_mode_threshold: 85 }));
    await waitFor(() => expect(text("dirty")).toBe("true"));

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Firewall settings",
        level: "warning",
        canSave: true,
        canDiscard: true,
      },
    ]);
    const preparing = prepareLifecycle(quitIntent);
    await act(async () => Promise.resolve());
    expect(mocks.putSettings).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { level: "blocking", canSave: false, canDiscard: false },
    ]);

    await act(async () => {
      pendingSave.resolve({
        data: settings({ attack_mode_threshold: 85 }),
      });
      await preparing;
    });
    expect(text("dirty")).toBe("false");

    act(() => latest?.setDraft({ attack_mode_threshold: 95 }));
    await waitFor(() => expect(text("dirty")).toBe("true"));
    const proceeded = vi.fn();
    const transition = requestLifecycleTransition(quitIntent, proceeded);
    await waitFor(() =>
      expect(getLifecycleDecisionState().phase).toBe("review"),
    );
    await act(async () => discardAndRecheckLifecycleTransition());
    await expect(transition).resolves.toBe("proceeded");
    expect(text("threshold")).toBe("85");
    expect(text("dirty")).toBe("false");
  });

  it("contains a thrown firewall save and retains the retryable lifecycle draft", async () => {
    mocks.putSettings.mockRejectedValueOnce(new Error("transport offline"));
    await renderLoaded();
    act(() => latest?.setDraft({ attack_mode_threshold: 85 }));
    await waitFor(() => expect(text("dirty")).toBe("true"));

    await act(async () => prepareLifecycle(quitIntent));
    expect(text("dirty")).toBe("true");
    expect(text("saving")).toBe("false");
    expect(text("error")).toBe("none");
    expect(latest?.saveError).toBe("transport offline");
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { level: "warning", canSave: true, canDiscard: true },
    ]);
  });
});
