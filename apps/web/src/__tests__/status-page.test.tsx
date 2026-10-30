import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import StatusPage from "@/app/(public)/status/page";

const { connection, fetchPublicStatus, healthySnapshot } = vi.hoisted(() => {
  const healthySnapshot = {
    overall_status: "ok" as const,
    generated_at: "2026-06-27T00:00:00Z",
    services: [
      {
        service: "api",
        status: "ok" as const,
        uptime_30d: 1,
        last_pinged_at: "2026-06-27T00:00:00Z",
        latency_ms: 42,
      },
    ],
    active_incidents: [],
    recent_incidents: [],
    history_90d: {
      api: [{ day: "2026-06-27", uptime: 1, incidents: 0 }],
    },
  };
  return {
    connection: vi.fn(async () => undefined),
    fetchPublicStatus: vi.fn(async () => healthySnapshot),
    healthySnapshot,
  };
});

vi.mock("next/server", () => ({ connection }));

vi.mock("@/lib/public-status-api", () => ({
  fetchPublicStatus,
}));

describe("status page subscription surface", () => {
  beforeEach(() => {
    fetchPublicStatus.mockResolvedValue(healthySnapshot);
  });

  it("waits for a runtime request before loading live status", async () => {
    await StatusPage();

    expect(connection).toHaveBeenCalledOnce();
  });

  it("ships a mailto subscription path instead of a disabled POST form", async () => {
    const html = renderToStaticMarkup(await StatusPage());

    expect(html).toContain("mailto:status-subscribe@moosewave.com");
    expect(html).not.toContain('action="/api/status/subscribe"');
    expect(html).not.toContain("subscribe_error");
    expect(html).toContain('<main id="status-main"');
    expect(html).toContain('href="#status-main"');
  });

  it("never claims everything is operational when service data is absent", async () => {
    fetchPublicStatus.mockResolvedValueOnce({
      ...healthySnapshot,
      services: [],
      history_90d: { api: [] },
    });

    const html = renderToStaticMarkup(await StatusPage());

    expect(html).toContain("Service monitoring is initializing");
    expect(html).not.toContain("All systems operational");
    expect(html).toContain("Individual service details are not available");
  });
});
