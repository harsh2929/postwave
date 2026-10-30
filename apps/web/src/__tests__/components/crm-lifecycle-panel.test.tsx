// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// CrmLifecyclePanel had NEITHER a test nor a page that renders it: nothing
// imported the module, so its whole connect/sync/pause/resume/disconnect
// lifecycle — and the per-row branch that decides whether a row shows Pause or
// Resume — never ran under test.
//
// Served from a route table rather than the recorded-fixture transport because
// no /api/v1/crm/* response was ever recorded; on fixtures alone the panel
// renders only its error branch and proves nothing about the list.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CrmIntegration, CrmProviderSpec } from "@/lib/crm-api";

import { flush, stubRouteTransport } from "../helpers/route-transport";
import {
  clickEveryControl,
  renderPage,
  unmount,
  WHOAMI,
} from "../pages/_harness";

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  // Both the panel's meQuery and useAdminGate() read whoami; owner makes
  // canWrite true so the write controls are actually rendered and clicked.
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

const PROVIDERS: CrmProviderSpec[] = [
  {
    provider: "hubspot",
    name: "HubSpot",
    category: "crm",
    auth_mode: "oauth",
    managed: true,
    runtime_status: "available",
    capabilities: ["contacts"],
    required_settings: [],
    scopes: ["crm.objects.contacts.read"],
    sync_objects: ["contact"],
    docs_url: "https://example.test/hubspot",
  },
  {
    provider: "zoho-crm",
    name: "Zoho CRM",
    category: "crm",
    auth_mode: "vault_ref",
    managed: false,
    runtime_status: "available",
    capabilities: ["contacts"],
    required_settings: [],
    scopes: [],
    sync_objects: ["contact"],
    docs_url: "https://example.test/zoho",
  },
];

const INTEGRATIONS: CrmIntegration[] = [
  {
    id: "crm_active",
    provider: "hubspot",
    name: "HubSpot production",
    status: "active",
    scopes: [],
    last_sync_at: "2026-08-01T10:30:00Z",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-08-01T10:30:00Z",
  },
  {
    id: "crm_paused",
    provider: "zoho-crm",
    name: "Zoho sandbox",
    status: "paused",
    scopes: [],
    error_message: "token expired at the provider",
    last_sync_at: null,
    created_at: "2026-07-02T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
  },
];

function routes(items: CrmIntegration[] = INTEGRATIONS) {
  return {
    "/api/v1/auth/me": WHOAMI,
    "/api/v1/crm/providers": { items: PROVIDERS },
    "/api/v1/crm/integrations": { items },
  };
}

async function panel() {
  return (await import("@/components/integrations/crm-lifecycle-panel"))
    .CrmLifecyclePanel;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("CrmLifecyclePanel", () => {
  beforeEach(() => {
    stubRouteTransport(routes());
  });

  it("renders one card per integration with its status and last sync", async () => {
    const CrmLifecyclePanel = await panel();
    const { text, root } = await renderPage(CrmLifecyclePanel);
    try {
      expect(text).toContain("CRM");
      expect(text).toContain("HubSpot production");
      expect(text).toContain("Zoho sandbox");
      // Row-level detail, not just the names: the provider id and the error
      // message the server attached to the paused one.
      expect(text).toContain("token expired at the provider");
      // fmtDate(null) — the row must say "never", not render an Invalid Date.
      expect(text).toContain("last sync never");
      expect(text).not.toContain("Invalid Date");
      // With items present the empty state must NOT also be on screen.
      expect(text).not.toContain("No CRM integrations connected");
    } finally {
      unmount(root);
    }
  });

  it("offers Pause on the active row and Resume on the paused one", async () => {
    const CrmLifecyclePanel = await panel();
    const { container, root } = await renderPage(CrmLifecyclePanel);
    try {
      const labels = [...container.querySelectorAll("button")].map((b) =>
        b.textContent?.trim(),
      );
      // Falsifiable both ways: inverting the `paused` test, or hoisting either
      // button out of its branch, changes these counts.
      expect(labels.filter((l) => l === "Pause")).toHaveLength(1);
      expect(labels.filter((l) => l === "Resume")).toHaveLength(1);
      expect(labels.filter((l) => l === "Sync now")).toHaveLength(2);
      expect(labels.filter((l) => l === "Disconnect")).toHaveLength(2);
    } finally {
      unmount(root);
    }
  });

  it("shows the empty state, not a bare list, when nothing is connected", async () => {
    vi.unstubAllGlobals();
    stubRouteTransport(routes([]));
    const CrmLifecyclePanel = await panel();
    const { text, root } = await renderPage(CrmLifecyclePanel);
    try {
      expect(text).toContain("No CRM integrations connected");
    } finally {
      unmount(root);
    }
  });

  it("reveals the connect form, listing every provider, when Connect CRM is pressed", async () => {
    const CrmLifecyclePanel = await panel();
    const { container, root } = await renderPage(CrmLifecyclePanel);
    try {
      const connect = [...container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Connect CRM",
      );
      expect(connect).toBeDefined();
      await flush(container);
      connect!.click();
      await flush(container);

      const select = container.querySelector<HTMLSelectElement>(
        "#crm-connect-provider",
      );
      expect(select).not.toBeNull();
      expect(
        [...select!.querySelectorAll("option")].map((o) => o.textContent),
      ).toEqual(["HubSpot (OAuth)", "Zoho CRM"]);
      // hubspot is managed, so the form must show the OAuth path — not the
      // vault-credential form.
      expect(container.textContent).toContain("Connect with HubSpot");
      expect(container.querySelector("#crm-connect-credref")).toBeNull();
    } finally {
      unmount(root);
    }
  });

  it("clicks every control without a handler exploding", async () => {
    const CrmLifecyclePanel = await panel();
    const { container, root } = await renderPage(CrmLifecyclePanel);
    try {
      // Proves the next assertion is falsifiable: the dialog is not in the DOM
      // until something opens it.
      expect(document.body.textContent).not.toContain("Disconnect this CRM?");
      const { clicked, failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
      // Connect CRM, Refresh, and 4 lifecycle buttons across 2 rows.
      expect(clicked).toBeGreaterThanOrEqual(6);
      // Disconnect is confirm-gated: pressing it must open the dialog rather
      // than disconnect, and the dialog names the target.
      expect(document.body.textContent).toContain("Disconnect this CRM?");
    } finally {
      unmount(root);
    }
  });
});
