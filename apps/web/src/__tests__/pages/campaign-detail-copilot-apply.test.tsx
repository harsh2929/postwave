// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The campaign editor hands the Copilot rail its subject setter (rows
// campaigns-3 / -4): a Subject Lab, brief or idea pick lands in the draft's
// Subject field as an unsaved edit. (The rail only renders for an editable
// draft.) The rail itself is stubbed; its own suites cover it.
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";
import { importBeforeTests, waitFor } from "./_wait";

const CAMPAIGN_ID = "11111111-2222-3333-4444-555555555555";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => `/app/campaigns/${CAMPAIGN_ID}`,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: CAMPAIGN_ID }),
  redirect: vi.fn(),
}));

const me = WHOAMI;

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn(async () => me),
}));

vi.mock("@/components/ai/copilot-rail", () => ({
  CopilotRail: (props: { onApplySubject?: (subject: string) => void }) =>
    props.onApplySubject
      ? createElement(
          "button",
          {
            type: "button",
            "data-testid": "stub-rail-apply",
            onClick: () => props.onApplySubject?.("Lab pick: autumn is here"),
          },
          "Stub apply",
        )
      : createElement("p", {}, "no hand-off"),
}));

const CAMPAIGN = {
  id: CAMPAIGN_ID,
  tenant_id: WHOAMI.tenant_id,
  name: "Autumn launch",
  subject: "Original subject",
  status: "draft",
  editor_mode: "html",
  body_html: "<p>Hello</p>",
  delivery_settings: { from_email: "news@brand.example" },
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

// The page module these tests import is cold work for vitest's transform
// pipeline; pay it before any test's 5 s clock starts. The same goes for every
// section the page loads with React.lazy, for a second reason: a section
// still loading when the test unmounts resolves after the file has ended, and
// React then logs "A suspended resource finished loading" through a worker
// that may already be closed, which fails the run.
importBeforeTests(
  () => import("@/app/(dashboard)/app/campaigns/[id]/campaign-detail-client"),
  () => import("@/components/mailchimp-parity/campaign-intelligence-panel"),
  () => import("@/app/(dashboard)/app/campaigns/[id]/campaign-content-editor"),
  () =>
    import("@/app/(dashboard)/app/campaigns/[id]/campaign-semantic-source-editor"),
  () => import("@/app/(dashboard)/app/campaigns/[id]/campaign-variants-section"),
  () =>
    import("@/app/(dashboard)/app/campaigns/[id]/campaign-operational-panels"),
  () => import("@/app/(dashboard)/app/campaigns/[id]/campaign-audience-section"),
  () => import("@/app/(dashboard)/app/campaigns/[id]/campaign-fields-section"),
  () => import("@/app/(dashboard)/app/campaigns/[id]/campaign-tracking-section"),
  () =>
    import("@/app/(dashboard)/app/campaigns/[id]/campaign-test-send-section"),
  () =>
    import("@/app/(dashboard)/app/campaigns/[id]/campaign-activity-timeline"),
  () => import("@/components/ai/copilot-rail"),
  () => import("@/components/campaigns/email-preview"),
  () => import("@/app/(dashboard)/app/campaigns/campaign-send-dialogs"),
);

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(raw, "http://postwave.test").pathname;
      if (path === "/api/v1/auth/me") {
        return new Response(JSON.stringify(me), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === `/api/v1/campaigns/${CAMPAIGN_ID}`) {
        return new Response(JSON.stringify(CAMPAIGN), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"v1"' },
        });
      }
      return new Response(JSON.stringify({ error: { code: "not_found", message: "" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("campaign editor ↔ Copilot rail subject hand-off", () => {
  it("applies a rail pick to the draft's Subject field as an unsaved edit", async () => {
    const { CampaignDetailClient } = await import(
      "@/app/(dashboard)/app/campaigns/[id]/campaign-detail-client"
    );
    const { container, root } = await renderPage(CampaignDetailClient);
    try {
      const subject = () =>
        container.querySelector<HTMLInputElement>("#campaign-subject");
      await waitFor(() => expect(subject()?.value).toBe("Original subject"));
      await waitFor(() =>
        expect(container.querySelector('[data-testid="stub-rail-apply"]')).not.toBeNull(),
      );
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="stub-rail-apply"]')!.click();
      });
      expect(subject()?.value).toBe("Lab pick: autumn is here");
    } finally {
      unmount(root);
    }
  });
});
