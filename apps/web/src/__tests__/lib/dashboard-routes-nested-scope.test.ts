// SPDX-License-Identifier: AGPL-3.0-only
//
// The ⌘K palette lists pages that live under a section (Outbound webhooks under
// Routing, Gift history under Source quality, the webhook simulator and API
// playground under Developer reference). A nested page the shared manifest does
// not model must keep its section's visibility: Routing is admin-only, so its
// child must not surface as a member route or downgrade the deep link.

import { describe, expect, it } from "vitest";

import {
  DASHBOARD_COMMAND_GO_ROUTES,
  DASHBOARD_ROUTES,
  dashboardRouteScopeForHref,
} from "@/lib/dashboard-routes";

function route(href: string) {
  return DASHBOARD_ROUTES.find((r) => r.href === href);
}

describe("nested section pages in the command palette", () => {
  it("lists each page built for desktop parity under Go", () => {
    const hrefs = DASHBOARD_COMMAND_GO_ROUTES.map((r) => r.href);
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/app/routing/outbound-webhooks",
        "/app/source-quality/gifts",
        "/app/developer-reference/webhook-simulator",
        "/app/developer-reference/playground",
      ]),
    );
  });

  it("keeps them out of the sidebar, which shows the section instead", () => {
    expect(route("/app/routing/outbound-webhooks")?.sidebar).toBeFalsy();
    expect(route("/app/source-quality/gifts")?.sidebar).toBeFalsy();
  });

  it("inherits the section's scope instead of defaulting to member", () => {
    expect(route("/app/routing")?.scope).toBe("admin");
    expect(route("/app/routing/outbound-webhooks")?.scope).toBe("admin");
    expect(dashboardRouteScopeForHref("/app/routing/outbound-webhooks")).toBe(
      "admin",
    );
    expect(
      dashboardRouteScopeForHref("/app/routing/outbound-webhooks/anything"),
    ).toBe("admin");
    expect(route("/app/source-quality/gifts")?.scope).toBe("member");
    expect(route("/app/developer-reference/playground")?.scope).toBe("member");
  });
});
