import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ openUrl: vi.fn() }));

vi.mock("../../lib/tauri", () => ({
  isTauri: () => false,
  tauriApi: {
    openUrl: mocks.openUrl,
    getAppVersion: vi.fn(),
    getPlatform: vi.fn(),
    readDesktopDiagnostics: vi.fn(),
  },
}));

vi.mock("../../lib/desktop-router", () => ({
  getDesktopRoute: () => ({
    section: "subscribers",
    resourceId: "person@example.com",
    query: "secret customer content",
  }),
}));

vi.mock("../../lib/online-manager", () => ({
  getConnectivitySnapshot: () => ({
    status: "offline",
    reason: "api-unavailable",
    checkedAt: 1,
  }),
}));

import { openDesktopSupport } from "../../lib/desktop-recovery";

describe("desktop recovery support handoff", () => {
  it("retains structural recovery context without forwarding route payload", async () => {
    mocks.openUrl.mockResolvedValueOnce(undefined);

    await openDesktopSupport({
      task: "recovery",
      errorCode: "RENDERER_FAILURE",
      incidentId: "PW-20260716-A1B2C3D4E5",
    });

    const value = mocks.openUrl.mock.calls[0]?.[0] as string;
    const url = new URL(value);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      source: "desktop",
      destination: "subscribers",
      domain: "audience",
      connection: "api-unavailable",
      task: "recovery",
      error_code: "RENDERER_FAILURE",
      incident_id: "PW-20260716-A1B2C3D4E5",
    });
    expect(value).not.toContain("person%40example.com");
    expect(value).not.toContain("customer+content");
  });
});
