// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Lean staging runs without the Campaign Assurance runtime. The campaign
// editor then received a sanitized 503 "an internal error occurred" and showed
// it as a red alert with a Retry button that could never succeed. The API now
// answers with a stable capability code; this renders the real panel over the
// real query client, API client and transport, with only `fetch` replaced by
// the API's response, byte for byte.
import { QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
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

import {
  CampaignAssurancePanel,
  CampaignAssuranceSendStatus,
} from "@/app/(dashboard)/app/campaigns/[id]/campaign-assurance-panel";
import { ApiError, apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import { campaignAssuranceErrorMessage } from "@/lib/campaign-assurance-api";
import { makeQueryClient } from "@/lib/query-client";

const NOT_ENABLED_BODY =
  '{"error":{"code":"campaign_assurance_not_enabled","message":"Campaign Assurance is not enabled on this deployment","retryable":false}}\n';

const IDENTITY: MeResponse = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "editor@example.test",
  role: "editor",
  effective_role: "editor",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

let root: Root | null = null;
let assuranceRequests: string[] = [];

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  assuranceRequests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/assurance")) assuranceRequests.push(url);
      return new Response(NOT_ENABLED_BODY, {
        status: 503,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }),
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderWithClient(node: ReturnType<typeof createElement>) {
  const client = makeQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(QueryClientProvider, { client }, node));
  });
  // Long enough for every transport retry and query retry that would follow
  // a retryable failure to have fired.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  return container;
}

describe("Campaign Assurance when the environment runs without it", () => {
  it("says so plainly, once, with nothing to retry or run", async () => {
    const container = await renderWithClient(
      createElement(CampaignAssurancePanel, {
        campaignId: "campaign-1",
        tenantId: "tenant-1",
        role: "editor",
        canOverride: false,
        canEdit: true,
        canApply: true,
        campaignETag: '"campaign-v1"',
        identity: IDENTITY,
      }),
    );

    expect(container.textContent).toContain(
      "Campaign Assurance isn't turned on in this environment",
    );
    expect(container.textContent).toContain("Sending isn't affected");
    expect(container.textContent).not.toContain("an internal error occurred");
    expect(container.textContent).not.toContain("currently unavailable");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const labels = Array.from(container.querySelectorAll("button")).map(
      (button) => button.textContent ?? "",
    );
    expect(labels.filter((label) => /retry|run full assurance/i.test(label))).toEqual(
      [],
    );
    // One request: no transport re-sends and no query retries for a state
    // that asking again cannot change.
    expect(assuranceRequests).toHaveLength(1);
  });

  it("tells the send dialog that nothing waits on a receipt", async () => {
    const container = await renderWithClient(
      createElement(CampaignAssuranceSendStatus, {
        campaignId: "campaign-1",
        tenantId: "tenant-1",
        role: "editor",
      }),
    );

    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain(
      "Campaign Assurance isn't turned on in this environment",
    );
    expect(container.textContent).not.toContain("could not be loaded");
    expect(assuranceRequests).toHaveLength(1);
  });
});

// The API's "unavailable" answers are written for API clients: the transient
// one tells the caller to retry with the same request_id and Idempotency-Key.
// The panel shows its own words for them, never the API's instructions.
const TRANSIENT_BODY =
  '{"error":{"code":"campaign_assurance_unavailable","message":"Predicted Agent Comprehension is temporarily unavailable; retry with the same request_id and Idempotency-Key","retryable":true,"request_id":"req-assurance-1"}}\n';

describe("Campaign Assurance when its runtime is briefly unavailable", () => {
  it("tells the person what to do instead of repeating the API's instructions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/assurance")) assuranceRequests.push(url);
        return new Response(TRANSIENT_BODY, {
          status: 503,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "retry-after": "5",
          },
        });
      }),
    );
    const container = await renderWithClient(
      createElement(CampaignAssurancePanel, {
        campaignId: "campaign-1",
        tenantId: "tenant-1",
        role: "editor",
        canOverride: false,
        canEdit: true,
        canApply: true,
        campaignETag: '"campaign-v1"',
        identity: IDENTITY,
      }),
    );
    // A retryable answer: let the transport's Retry-After re-sends and the
    // query's own retries run out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      "Campaign Assurance is temporarily unavailable. Try again in a few seconds.",
    );
    expect(container.textContent).not.toContain("Idempotency-Key");
    expect(container.textContent).not.toContain("request_id");
  });
});

describe("campaignAssuranceErrorMessage", () => {
  it("words the configuration answers from the user's side and keeps the request id", () => {
    const metering = new ApiError(
      "Campaign Assurance run metering is not configured on this deployment",
      503,
      undefined,
      { code: "campaign_assurance_metering_unavailable", requestId: "req-2" },
    );
    const remediation = new ApiError(
      "Campaign Assurance remediation is not configured on this deployment",
      503,
      undefined,
      { code: "campaign_assurance_remediation_unavailable" },
    );
    const other = new ApiError("the assurance run is not in an actionable completed state", 409, undefined, {
      code: "assurance_run_not_actionable",
    });

    const meteringMessage = campaignAssuranceErrorMessage(metering, "Could not start.");
    expect(meteringMessage).toContain(
      "Campaign Assurance runs aren't available in this environment.",
    );
    expect(meteringMessage).toContain("req-2");
    expect(meteringMessage).not.toContain("configured");
    expect(campaignAssuranceErrorMessage(remediation, "Could not repair.")).toBe(
      "Automatic repairs aren't available in this environment.",
    );
    // Every other answer keeps the shared rendering.
    expect(campaignAssuranceErrorMessage(other, "Could not repair.")).toBe(
      apiErrorMessage(other, "Could not repair."),
    );
  });
});
