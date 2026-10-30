// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";

import { GET, HEAD, dynamic, runtime } from "@/app/healthz/route";

describe("web process health route", () => {
  it("is uncached, node-backed, and independent of upstream services", async () => {
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("upstream unavailable"));

    const response = GET();

    expect(dynamic).toBe("force-dynamic");
    expect(runtime).toBe("nodejs");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "postwave-web",
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("supports bodyless health probes", async () => {
    const response = HEAD();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });
});
