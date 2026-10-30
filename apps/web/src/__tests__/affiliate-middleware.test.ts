import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/middleware", () => ({
  default: () => () => new Response(null),
}));

import { config, middleware } from "@/middleware";

describe("affiliate entry middleware", () => {
  it("does not route ref links through the closed affiliate program", () => {
    expect(config.matcher).toContain("/");

    const response = middleware(
      new NextRequest("https://moosewave.com/?ref=alice&utm_source=partner", {
        headers: { accept: "text/html" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive",
    );
  });
});
