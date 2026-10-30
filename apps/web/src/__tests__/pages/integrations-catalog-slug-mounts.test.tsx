// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Mount reachability for /app/integrations/catalog/[slug]:
//   platform-78..84 — the server's connector detail (lifecycle verbs, health,
//     contract, setup, recipes) renders under the hero
//   platform-86 — a native lead-capture provider gets the "Save
//     configuration" form instead of the "set up elsewhere" dead end
//   platform-91 — a release-held support provider offers the connect verb
//     through the held dialog (static catalog read, submit disabled with the
//     reason, no create request)
// and a release-held support provider sends no connector-detail read.
import { afterEach, describe, expect, it, vi } from "vitest";

import { SUPPORT_INTEGRATION_RUNTIME_HOLD_MESSAGE } from "@/lib/support-integration-operational-availability";
import { catalogItem, detailBody } from "../helpers/integrations-lifecycle-harness";
import { renderPage, unmount } from "./_harness";
import { buttonByText, clickEl, recordingTransport, settle } from "./_mount-transport";

const nav = vi.hoisted(() => ({ slug: "hubspot" }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: nav.slug }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/app/integrations/catalog/${nav.slug}`,
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const { WHOAMI: me } = await import("./_harness");
  return {
    ...(await importOriginal<typeof import("@/lib/auth-api")>()),
    whoami: vi.fn().mockResolvedValue(me),
    whoamiFresh: vi.fn().mockResolvedValue(me),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  nav.slug = "hubspot";
});

const CATALOG = {
  schema_version: "1",
  target_public_entries: 3,
  target_native_managed: 2,
  honest_badges: ["native"],
  categories: [
    { key: "crm", label: "CRM" },
    { key: "lead_capture", label: "Lead capture" },
    { key: "customer_service", label: "Customer service" },
  ],
  capabilities: ["contacts"],
  counts: { available: 3 },
  items: [
    catalogItem(),
    catalogItem({
      slug: "typeform",
      name: "Typeform",
      category: "lead_capture",
      sources: ["lead_capture"],
      setup_path: undefined,
    }),
    catalogItem({
      slug: "zendesk",
      name: "Zendesk",
      category: "customer_service",
      sources: ["support_integration"],
    }),
  ],
};

const LEAD_PROVIDERS = {
  items: [
    {
      provider: "typeform",
      name: "Typeform",
      category: "lead_capture",
      auth_mode: "api_token_ref",
      managed: true,
      runtime_status: "available",
      sync_model: "postwave_lead_pull",
      sync_objects: ["responses"],
      required_settings: [{ key: "form_id", label: "Form ID", required: true }],
      optional_settings: [],
    },
  ],
};

const SUPPORT_PROVIDERS = {
  items: [
    {
      key: "zendesk",
      name: "Zendesk",
      runtime_status: "held",
      hold_code: "support_integration_runtime_held",
    },
  ],
  complete: true,
  provenance: { tenant_bound: false, source: "static_server_catalog" },
};

async function mount(slug: string) {
  nav.slug = slug;
  const transport = recordingTransport((req) => {
    if (req.method !== "GET") return undefined;
    if (req.path === "/api/v1/integrations/catalog") return { body: CATALOG };
    if (req.path === "/api/v1/integrations/hubspot") return { body: detailBody() };
    if (req.path === "/api/v1/lead-integrations/providers") {
      return { body: LEAD_PROVIDERS };
    }
    if (req.path === "/api/v1/support-integrations/providers") {
      return { body: SUPPORT_PROVIDERS };
    }
    return undefined;
  });
  const Page = (await import("@/app/(dashboard)/app/integrations/catalog/[slug]/page"))
    .default;
  const rendered = await renderPage(Page);
  await settle(6);
  return { ...transport, ...rendered };
}

describe("integration catalog detail mounts", () => {
  it("renders the connector detail panels from the server's detail read (platform-78..84)", async () => {
    const { calls, container, root } = await mount("hubspot");
    try {
      // The connector detail is a next/dynamic chunk; give it a bounded
      // moment to mount, issue its read, and paint the response.
      const deadline = Date.now() + 10_000;
      while (
        !container.textContent?.includes("Store the credential") &&
        Date.now() < deadline
      ) {
        await settle(1);
      }
      expect(
        calls.some((c) => c.method === "GET" && c.path === "/api/v1/integrations/hubspot"),
      ).toBe(true);
      const headings = [...container.querySelectorAll("h2")].map((h) =>
        h.textContent?.trim(),
      );
      expect(headings).toContain("Connection & lifecycle");
      expect(container.textContent).toContain("Store the credential");
    } finally {
      unmount(root);
    }
  });

  it("offers the lead-capture Save configuration form for a native lead provider (platform-86)", async () => {
    const { calls, container, root } = await mount("typeform");
    try {
      // The lead-capture form is a next/dynamic chunk; give it a bounded
      // moment to mount, issue its read, and paint the response.
      const findFormIdLabel = () =>
        [...container.querySelectorAll("label")].find((l) =>
          l.textContent?.startsWith("Form ID"),
        );
      const deadline = Date.now() + 10_000;
      while (!findFormIdLabel() && Date.now() < deadline) {
        await settle(1);
      }
      expect(
        calls.some(
          (c) => c.method === "GET" && c.path === "/api/v1/lead-integrations/providers",
        ),
      ).toBe(true);
      const formIdLabel = findFormIdLabel();
      expect(formIdLabel).toBeDefined();
      expect(container.textContent).not.toContain(
        "This integration is set up from another surface",
      );
    } finally {
      unmount(root);
    }
  });

  it("sends no connector-detail read for a release-held support provider", async () => {
    const { calls, container, root } = await mount("zendesk");
    try {
      expect(container.textContent).toContain("Support integration runtime held");
      expect(calls.some((c) => c.path === "/api/v1/integrations/zendesk")).toBe(
        false,
      );
    } finally {
      unmount(root);
    }
  });

  it("opens the held support connect dialog from its trigger: static catalog read, submit disabled with the reason, no create (platform-91)", async () => {
    const { calls, container, root } = await mount("zendesk");
    try {
      // Nothing about the dialog is loaded until the operator asks for it.
      expect(
        calls.some((c) => c.path === "/api/v1/support-integrations/providers"),
      ).toBe(false);
      const trigger = buttonByText(container, /^Connect$/);
      expect(trigger).toBeDefined();
      await clickEl(trigger);

      // The dialog is a next/dynamic chunk; give it a bounded moment to mount,
      // read the static catalog, and paint the held submit. The resolved
      // provider label is what proves the catalog read landed and decoded.
      const findSubmit = () => buttonByText(document.body, "Connect — unavailable");
      const catalogResolved = () =>
        document.body.textContent?.includes("Reported provider: Zendesk") ?? false;
      const deadline = Date.now() + 10_000;
      while ((!findSubmit() || !catalogResolved()) && Date.now() < deadline) {
        await settle(1);
      }
      const submit = findSubmit();
      expect(submit).toBeDefined();
      expect(submit!.disabled).toBe(true);
      expect(submit!.getAttribute("title")).toBe(
        SUPPORT_INTEGRATION_RUNTIME_HOLD_MESSAGE,
      );
      const describedBy = submit!.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(
        document.body.querySelector(`[id="${describedBy}"]`)?.textContent,
      ).toContain(SUPPORT_INTEGRATION_RUNTIME_HOLD_MESSAGE);
      // The dialog resolved the catalog row against the static provider list.
      expect(document.body.textContent).toContain("Reported provider: Zendesk");

      expect(
        calls.filter(
          (c) => c.method === "GET" && c.path === "/api/v1/support-integrations/providers",
        ),
      ).toHaveLength(1);
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
      expect(calls.some((c) => c.path === "/api/v1/integrations/zendesk")).toBe(false);
    } finally {
      unmount(root);
    }
  });
});
