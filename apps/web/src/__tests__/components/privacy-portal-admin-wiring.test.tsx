// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  getPortal: vi.fn(),
  getPending: vi.fn(),
  getBranding: vi.fn(),
  createRegion: vi.fn(),
  deleteRegion: vi.fn(),
  extendPending: vi.fn(),
  cancelPending: vi.fn(),
  saveBranding: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/privacy-portal-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/privacy-portal-api")>()),
  getPrivacyPortal: mocks.getPortal,
  getDoubleOptInPending: mocks.getPending,
  getPreferenceCentreBranding: mocks.getBranding,
  createPrivacyRegion: mocks.createRegion,
  deletePrivacyRegion: mocks.deleteRegion,
  extendDoubleOptInWindow: mocks.extendPending,
  cancelDoubleOptIn: mocks.cancelPending,
  savePreferenceCentreBranding: mocks.saveBranding,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import PrivacyPortalPage from "@/app/(dashboard)/app/privacy-portal/page";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "99999999-9999-4999-8999-999999999999";
const REGION_ID = "22222222-2222-4222-8222-222222222222";
const PENDING_ID = "33333333-3333-4333-8333-333333333333";
const ME = {
  user_id: USER,
  tenant_id: TENANT,
  email: "admin@example.com",
  role: "admin" as const,
  effective_role: "admin" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};
const REGION = {
  id: REGION_ID,
  tenantId: TENANT,
  region_code: "EU",
  framework: "gdpr" as const,
  requires_double_optin: true,
  requires_explicit_consent: true,
  do_not_sell_default: false,
  gpc_honored: true,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-02T00:00:00Z",
};
const PORTAL = {
  tenantId: TENANT,
  regions: [REGION],
  dsar_requests: [{ request_type: "erasure", open: 3, overdue: 1, closed: 9 }],
  suppression_breakdown: [{ reason: "hard_bounce", count: 4 }],
  consent_proof_summary: [{ source: "hosted_form", count: 12 }],
  gpc_signaled_count: 7,
  do_not_sell_count: 5,
  double_optin_pending: 1,
  generated_at: "2026-08-29T10:00:00Z",
};
const PENDING = {
  tenantId: TENANT,
  count: 1,
  pending: [
    {
      id: PENDING_ID,
      email: "pending@example.com",
      sent_at: "2026-08-20T08:00:00Z",
      expires_at: "2026-10-19T08:00:00Z",
    },
  ],
};
const BRANDING = {
  tenantId: TENANT,
  logo_url: "",
  primary_color: "#123ABC",
  footer_text: "Subscriber controls",
  show_postwave_badge: true,
};

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoami.mockResolvedValue(ME);
  mocks.getPortal.mockResolvedValue(PORTAL);
  mocks.getPending.mockResolvedValue(PENDING);
  mocks.getBranding.mockResolvedValue(BRANDING);
  mocks.createRegion.mockResolvedValue({
    ...REGION,
    id: "44444444-4444-4444-8444-444444444444",
    region_code: "US-CA",
  });
  mocks.extendPending.mockResolvedValue({
    ok: true,
    tenantId: TENANT,
    id: PENDING_ID,
  });
  mocks.saveBranding.mockImplementation(async (draft) => ({
    tenantId: TENANT,
    ...draft,
  }));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function renderPage(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PrivacyPortalPage),
      ),
    );
  });
  return { root, container };
}

async function settle(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function change(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("privacy portal administrator wiring", () => {
  it("does not request compliance data for a viewer or viewer-mode identity", async () => {
    mocks.whoami.mockResolvedValue({
      ...ME,
      role: "viewer",
      effective_role: "viewer",
    });
    const { root, container } = renderPage();
    try {
      await settle();
      expect(container.textContent).toContain(
        "Owner or administrator access required",
      );
      expect(mocks.getPortal).not.toHaveBeenCalled();
      expect(mocks.getPending).not.toHaveBeenCalled();
      expect(mocks.getBranding).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders the correct aggregate contract and wires create, extend, and theme save", async () => {
    const { root, container } = renderPage();
    try {
      await settle();
      // The admin workspace and its compliance dashboard are next/dynamic
      // chunks now; wait for both to mount rather than assuming a fixed
      // number of event-loop turns.
      const deadline = Date.now() + 10_000;
      while (
        !(
          container.textContent?.includes("Subscriber controls") &&
          container.textContent?.includes("DSAR by request type")
        ) &&
        Date.now() < deadline
      ) {
        await settle(1);
      }
      expect(container.textContent).toContain("erasure");
      expect(container.textContent).toContain("hard bounce");
      expect(container.textContent).toContain("pending@example.com");
      expect(container.textContent).toContain("Subscriber controls");

      const regionCode = container.querySelector(
        "#privacy-region-code",
      ) as HTMLInputElement;
      act(() => change(regionCode, "us-ca"));
      await act(async () => {
        button(container, "Add region").click();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      await settle();
      expect(mocks.createRegion).toHaveBeenCalledWith(
        expect.objectContaining({ region_code: "US-CA" }),
        TENANT,
        expect.any(AbortSignal),
      );

      await act(async () => {
        button(container, "Extend 60 days").click();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      await settle();
      expect(mocks.extendPending).toHaveBeenCalledWith(
        PENDING_ID,
        TENANT,
        expect.any(AbortSignal),
      );

      const footer = container.querySelector(
        "#preference-footer",
      ) as HTMLTextAreaElement;
      act(() => change(footer, "Updated subscriber controls"));
      await act(async () => {
        button(container, "Save theme").click();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      await settle();
      expect(mocks.saveBranding).toHaveBeenCalledWith(
        expect.objectContaining({ footer_text: "Updated subscriber controls" }),
        TENANT,
        expect.any(AbortSignal),
      );
      // Parent verification plus two checks around each of three writes.
      expect(mocks.whoami.mock.calls.length).toBeGreaterThanOrEqual(7);
    } finally {
      act(() => root.unmount());
    }
  });
});
