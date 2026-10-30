// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  captureException: vi.fn(),
  isTauri: vi.fn(() => true),
  record: vi.fn<(record: unknown) => Promise<void>>(),
  restart: vi.fn<() => Promise<void>>(),
  setSafeMode: vi.fn<(active: boolean) => Promise<void>>(),
  takeCrash: vi.fn<
    () => Promise<{
      incidentId: string;
      occurredAtMs: number;
      kind: "native_panic";
      location: string | null;
    } | null>
  >(),
  read: vi.fn<() => Promise<string>>(),
  version: vi.fn<() => Promise<{ version: string; commit?: string } | null>>(),
  platform: vi.fn<() => Promise<"macos">>(),
}));

vi.mock("../../lib/sentry", () => ({
  captureException: native.captureException,
}));

vi.mock("../../lib/tauri", () => ({
  isTauri: native.isTauri,
  tauriApi: {
    recordRendererDiagnostic: native.record,
    restartApp: native.restart,
    setDesktopSafeMode: native.setSafeMode,
    takeNativeCrashRecord: native.takeCrash,
    readDesktopDiagnostics: native.read,
    getAppVersion: native.version,
    getPlatform: native.platform,
  },
}));

import {
  captureRendererIncident,
  getDesktopDiagnosticsState,
  initializeDesktopDiagnostics,
  resetDesktopDiagnosticsForTests,
  safeComponentTrace,
} from "../../lib/desktop-diagnostics";
import {
  buildDesktopDiagnosticsReport,
  restartDesktopInSafeMode,
} from "../../lib/desktop-recovery";

describe("desktop diagnostics privacy and recovery contract", () => {
  beforeEach(() => {
    resetDesktopDiagnosticsForTests();
    native.captureException.mockReset();
    native.record.mockReset().mockResolvedValue(undefined);
    native.restart.mockReset().mockResolvedValue(undefined);
    native.setSafeMode.mockReset().mockResolvedValue(undefined);
    native.takeCrash.mockReset().mockResolvedValue(null);
    native.read.mockReset().mockResolvedValue("");
    native.version
      .mockReset()
      .mockResolvedValue({ version: "1.2.3", commit: "abc123" });
    native.platform.mockReset().mockResolvedValue("macos");
    native.isTauri.mockReturnValue(true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetDesktopDiagnosticsForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reduces handled renderer errors to structural data before IPC or Sentry", async () => {
    initializeDesktopDiagnostics();
    const secret = "pw_live_never-store user@example.test";
    const developerPath = ["", "Users", "alice", "private.tsx"].join("/");
    const error = Object.assign(new Error(secret), { code: "E_RENDER" });
    const incident = captureRendererIncident("renderer_boundary", error, {
      fatal: true,
      componentStack: `\n    at CampaignEditor (${developerPath}:12:4)\n    at App (https://app.moosewave.com/?token=secret)`,
    });
    await Promise.resolve();

    expect(incident.incidentId).toMatch(/^PW-\d{8}-[A-F0-9]{10}$/);
    expect(incident).toMatchObject({
      kind: "renderer_boundary",
      errorType: "Error",
      errorCode: "E_RENDER",
      componentTrace: ["CampaignEditor", "App"],
    });
    expect(JSON.stringify(native.record.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(native.record.mock.calls)).not.toContain("alice");
    expect(String(native.captureException.mock.calls[0]?.[0])).not.toContain(
      secret,
    );
    expect(native.record).toHaveBeenCalledTimes(1);
  });

  it("enters Safe Mode on the next launch after a three-fatal crash loop", () => {
    initializeDesktopDiagnostics();
    for (let index = 0; index < 3; index += 1) {
      captureRendererIncident("renderer_boundary", new Error("boom"), {
        fatal: true,
      });
    }

    resetDesktopDiagnosticsForTests(false);
    const nextLaunch = initializeDesktopDiagnostics();
    expect(nextLaunch).toMatchObject({
      safeMode: true,
      safeModeReason: "crash_loop",
    });
  });

  it("counts recovered native panic markers toward the same crash-loop circuit", async () => {
    const occurredAtMs = Date.now();
    for (let index = 0; index < 3; index += 1) {
      native.takeCrash.mockResolvedValueOnce({
        incidentId: `PW-N-000000000000002A-00000001-0000000${index + 1}`,
        occurredAtMs: occurredAtMs + index,
        kind: "native_panic",
        location: "main.rs:12",
      });
      initializeDesktopDiagnostics();
      await Promise.resolve();
      resetDesktopDiagnosticsForTests(false);
    }
    expect(initializeDesktopDiagnostics()).toMatchObject({
      safeMode: true,
      safeModeReason: "crash_loop",
    });
  });

  it("persists a manual Safe Mode request before invoking a real restart", async () => {
    initializeDesktopDiagnostics();
    await restartDesktopInSafeMode();

    expect(native.restart).toHaveBeenCalledTimes(1);
    resetDesktopDiagnosticsForTests(false);
    initializeDesktopDiagnostics();
    expect(getDesktopDiagnosticsState()).toMatchObject({
      safeMode: true,
      safeModeReason: "manual",
    });
  });

  it("captures root error and rejection events without making them crash-loop votes", async () => {
    initializeDesktopDiagnostics();
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("secret renderer message") }),
    );
    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", {
      value: new Error("secret rejection"),
    });
    window.dispatchEvent(rejection);
    await Promise.resolve();

    expect(native.record.mock.calls.map((call) => call[0])).toMatchObject([
      { kind: "window_error" },
      { kind: "unhandled_rejection" },
    ]);
    resetDesktopDiagnosticsForTests(false);
    expect(initializeDesktopDiagnostics().safeMode).toBe(false);
  });

  it("builds a bounded support report with no raw exception text", async () => {
    initializeDesktopDiagnostics();
    const secret = "Bearer pw_live_secret@example.test";
    const incident = captureRendererIncident(
      "renderer_boundary",
      new Error(secret),
      { componentStack: "\n at SafePanel (/private/path.tsx:2:1)" },
    );
    native.read.mockResolvedValue(
      '{"source":"native","kind":"startup","safeMode":false}\n',
    );
    const report = await buildDesktopDiagnosticsReport(incident);

    expect(report).toContain(incident.incidentId);
    expect(report).toContain("Version: 1.2.3");
    expect(report).toContain("Platform: macos");
    expect(report).toContain("components=SafePanel");
    expect(report).not.toContain(secret);
    expect(report).not.toContain("private/path");
    expect(report.length).toBeLessThanOrEqual(48 * 1024);
  });

  it("extracts only allowlisted component names", () => {
    expect(
      safeComponentTrace(
        "at Good_Name (secret/path)\nat bad name (x)\nat pw_live_secret (x)\nat Also.Good (x)",
      ),
    ).toEqual(["Good_Name", "bad", "Also.Good"]);
  });
});
