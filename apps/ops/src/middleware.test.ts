// SPDX-License-Identifier: AGPL-3.0-only
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { middleware } from "./middleware";

const SESSION = `${"a".repeat(22)}.${"b".repeat(43)}`;

function get(path: string, cookie?: string): NextRequest {
  return new NextRequest(`https://ops.postwave.example${path}`, {
    headers: cookie ? { cookie } : {},
  });
}

describe("ops pre-auth gate", () => {
  it("refuses an operator surface that carries no session, before any handler runs", () => {
    const page = middleware(get("/tenants"));
    expect(page.status).toBe(401);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // `x-middleware-next` is how NextResponse.next() signals "carry on to the
    // handler"; its absence is the proof nothing downstream ran.
    expect(page.headers.get("x-middleware-next")).toBeNull();

    const api = middleware(get("/api/checks/billing/action"));
    expect(api.status).toBe(401);
    expect(api.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("refuses a cookie whose pw_session is not structurally a session", () => {
    expect(middleware(get("/tenants", "pw_session=attacker")).status).toBe(401);
    expect(middleware(get("/tenants", "tracking=abc")).status).toBe(401);
  });

  it("lets a structurally valid session through with its per-request nonce", () => {
    const response = middleware(get("/tenants", `tracking=abc; pw_session=${SESSION}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("content-security-policy")).toMatch(/'nonce-[A-Za-z0-9+/=]+'/u);
  });

  it("keeps container probes reachable without an operator session", () => {
    for (const path of ["/api/health", "/api/ready"]) {
      const response = middleware(get(path));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
  });
});
