// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// /app/deliverability "Sending controls" against the answers the API really
// gives a workspace that has never saved a sending policy.
//
// Staging showed "Evidence could not be verified." with a Retry on the click
// tracking, IP routing and inbox-test tiles, and made 9 requests doing it
// (3 routes x 3 attempts): the control API answered each unset policy with a
// bare 404 `not_found`, and the panel treated that as a failed read. The API
// now names the unset policy (click_tracking_not_configured, ...), and the
// panel shows that as a setup state. This renders the real panel through the
// real API client and the app's real query client; only fetch is stubbed.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeliverabilityOperationsPanel } from "@/app/(dashboard)/app/deliverability/operations-panel";
import type { MeResponse } from "@/lib/auth-api";
import { makeQueryClient } from "@/lib/query-client";

import { recordingTransport, settle, type Reply } from "../pages/_mount-transport";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const IDENTITY: MeResponse = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.test",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Operations",
  workspace_slug: "operations",
};

const CONTROL = "/api/v1/deliverability-control";

// The bodies GET click-tracking / ip-routing / entitlements write for a
// workspace with no saved policy (deliverability_control.writeRepoError).
const NOT_CONFIGURED: Record<string, Reply> = {
  [`${CONTROL}/click-tracking`]: {
    status: 404,
    body: {
      error: {
        code: "click_tracking_not_configured",
        message: "No click-tracking domain has been set up for this workspace.",
      },
    },
  },
  [`${CONTROL}/ip-routing`]: {
    status: 404,
    body: {
      error: {
        code: "ip_routing_not_configured",
        message:
          "No IP routing policy has been set up for this workspace; sending uses its default pool assignment.",
      },
    },
  },
  [`${CONTROL}/entitlements`]: {
    status: 404,
    body: {
      error: {
        code: "inbox_test_allowance_not_configured",
        message:
          "No inbox-test allowance is recorded for this workspace's current billing period.",
      },
    },
  },
};

const BASELINE: Record<string, Reply> = {
  [`${CONTROL}/domain-setups`]: { body: { items: [] } },
  "/api/v1/intelligent-retry/events": { body: { items: [] } },
  "/api/v1/soft-bounce-recovery/stats": {
    body: {
      disabled_count: 0,
      eligible_now: 0,
      eligible_suppressions_now: 0,
      recovery_window_days: 7,
      automatic_reactivation_active: false,
    },
  },
};

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function mount(replies: Record<string, Reply>) {
  const transport = recordingTransport((req) =>
    req.method === "GET" ? { ...BASELINE, ...replies }[req.path] : undefined,
  );
  const client = makeQueryClient();
  // Keep the app's retry policy, without its back-off delay.
  client.setDefaultOptions({
    ...client.getDefaultOptions(),
    queries: { ...client.getDefaultOptions().queries, retryDelay: 0 },
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <DeliverabilityOperationsPanel identity={IDENTITY} />
      </QueryClientProvider>,
    );
  });
  await settle(12);
  return { ...transport, container };
}

function tile(container: HTMLElement, heading: string): HTMLElement {
  const h3 = [...container.querySelectorAll("h3")].find(
    (el) => el.textContent === heading,
  );
  if (!h3?.parentElement) throw new Error(`tile ${heading} did not render`);
  return h3.parentElement;
}

describe("deliverability sending controls", () => {
  it("shows an unset policy as not set up, without an error, a Retry, or a retry request", async () => {
    const { container, calls } = await mount(NOT_CONFIGURED);

    for (const [heading, copy] of [
      ["Click tracking", "No custom tracking domain is configured"],
      ["IP routing", "Sending uses the default IP pool assignment"],
      ["Inbox-test entitlement", "No inbox-test allowance is recorded"],
    ] as const) {
      const el = tile(container, heading);
      expect(el.textContent).toContain("Not set up.");
      expect(el.textContent).toContain(copy);
      expect(el.textContent).not.toContain("could not be verified");
      expect(el.querySelector('[role="alert"]')).toBeNull();
      expect(el.querySelector("button")).toBeNull();
    }
    for (const path of Object.keys(NOT_CONFIGURED)) {
      expect(calls.filter((c) => c.path === path)).toHaveLength(1);
    }
    expect(tile(container, "Sending domains").textContent).toContain(
      "No sending domains configured.",
    );
  });

  it("shows a control service that is not deployed as unavailable here", async () => {
    const { container } = await mount({
      ...NOT_CONFIGURED,
      [`${CONTROL}/click-tracking`]: {
        status: 503,
        body: {
          error: {
            code: "service_not_deployed",
            message: "This feature isn't available in this environment.",
            retryable: false,
          },
        },
      },
    });
    const el = tile(container, "Click tracking");
    expect(el.textContent).toContain("Not available in this environment.");
    expect(el.querySelector("button")).toBeNull();
  });

  it("still reports a failed read as a failure with a Retry", async () => {
    const { container } = await mount({
      ...NOT_CONFIGURED,
      [`${CONTROL}/ip-routing`]: {
        status: 404,
        body: { error: { code: "not_found", message: "" } },
      },
    });
    const el = tile(container, "IP routing");
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(
      "Evidence could not be verified.",
    );
    expect(el.querySelector("button")?.textContent).toBe("Retry");
  });
});
