import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args) as Promise<unknown>,
  Channel: class<T> {
    onmessage: (message: T) => void;
    constructor(onmessage: (message: T) => void) {
      this.onmessage = onmessage;
    }
  },
}));

import { tauriApi } from "../../lib/tauri";

function enterTauri(): void {
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
}

afterEach(() => {
  invokeMock.mockReset();
  delete (globalThis as { window?: unknown }).window;
});

describe("native diagnostics IPC wrappers", () => {
  it("degrades to safe empty diagnostics outside Tauri", async () => {
    await expect(tauriApi.takeNativeCrashRecord()).resolves.toBeNull();
    await expect(tauriApi.readDesktopDiagnostics()).resolves.toBe("");
    await expect(tauriApi.setDesktopSafeMode(true)).resolves.toBeUndefined();
    await expect(
      tauriApi.recordRendererDiagnostic({
        incidentId: "PW-20260716-A1B2C3D4E5",
        occurredAtMs: 1,
        kind: "renderer_boundary",
        errorType: "Error",
        errorCode: null,
        componentTrace: [],
        safeMode: false,
      }),
    ).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("uses the exact native command and camel-case record contract", async () => {
    enterTauri();
    const record = {
      incidentId: "PW-20260716-A1B2C3D4E5",
      occurredAtMs: 1,
      kind: "renderer_boundary" as const,
      errorType: "TypeError",
      errorCode: "E_RENDER",
      componentTrace: ["CampaignEditor"],
      safeMode: false,
    };
    invokeMock.mockResolvedValueOnce(undefined);
    await tauriApi.recordRendererDiagnostic(record);
    expect(invokeMock).toHaveBeenCalledWith(
      "diagnostics_record_renderer_event",
      { record },
    );

    const crash = {
      incidentId: "PW-N-000000000000002A-00000001-00000001",
      occurredAtMs: 42,
      kind: "native_panic" as const,
      location: "main.rs:12",
    };
    invokeMock.mockResolvedValueOnce(crash);
    await expect(tauriApi.takeNativeCrashRecord()).resolves.toEqual(crash);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "diagnostics_take_startup_crash",
      undefined,
    );

    invokeMock.mockResolvedValueOnce('{"kind":"startup"}\n');
    await expect(tauriApi.readDesktopDiagnostics()).resolves.toContain(
      "startup",
    );
    expect(invokeMock).toHaveBeenLastCalledWith(
      "diagnostics_read_recent",
      undefined,
    );

    invokeMock.mockResolvedValueOnce(undefined);
    await tauriApi.setDesktopSafeMode(true);
    expect(invokeMock).toHaveBeenLastCalledWith("diagnostics_set_safe_mode", {
      active: true,
    });
  });
});
