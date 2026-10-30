// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// /app/integration-catalogue against the shapes the server really sends.
//
// Staging crashed this page to "Could not load this view" with
// `TypeError: Cannot read properties of undefined (reading 'replaceAll')`:
// the row renderer called `category.replaceAll`, and
// GET /api/v1/support-integrations/providers answers the release-held
// projection documented as OpenAPI `SupportProviderSpec`
// (additionalProperties: false) — `{key, name, runtime_status, hold_code}`,
// with no `provider`, `category` or `auth_mode`. The smoke test never saw it
// because its fixture transport answers that path 404.
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount } from "./_harness";
import { recordingTransport, settle } from "./_mount-transport";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/integration-catalogue",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const { WHOAMI: me } = await import("./_harness");
  return {
    ...(await importOriginal<typeof import("@/lib/auth-api")>()),
    whoami: vi.fn().mockResolvedValue(me),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const HELD = {
  runtime_status: "held",
  hold_code: "support_integration_runtime_held",
} as const;

// The live staging body, trimmed to three of its 26 rows.
const SUPPORT_PROVIDERS = {
  items: [
    { key: "zendesk", name: "Zendesk", ...HELD },
    { key: "intercom", name: "Intercom", ...HELD },
    { key: "help_scout", name: "Help Scout", ...HELD },
  ],
  complete: true,
  provenance: { tenant_bound: false, source: "static_server_catalog" },
};

// A lead catalogue with one fully described row and one that omits the
// optional descriptive fields, so the renderer is exercised on both.
const LEAD_PROVIDERS = {
  items: [
    {
      provider: "typeform",
      name: "Typeform",
      category: "lead_capture",
      auth_mode: "api_token_ref",
      runtime_status: "partial",
      docs_url: "/docs/integrations/typeform",
    },
    { provider: "tally", name: "Tally", runtime_status: "partial" },
  ],
};

async function mount(support: unknown = SUPPORT_PROVIDERS) {
  const transport = recordingTransport((req) => {
    if (req.method !== "GET") return undefined;
    if (req.path === "/api/v1/support-integrations/providers") {
      return { body: support };
    }
    if (req.path === "/api/v1/lead-integrations/providers") {
      return { body: LEAD_PROVIDERS };
    }
    return undefined;
  });
  const Page = (await import("@/app/(dashboard)/app/integration-catalogue/page"))
    .default;
  const rendered = await renderPage(Page);
  await settle(8);
  return { ...transport, ...rendered };
}

function section(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    `[role="region"][aria-labelledby="${id}"]`,
  );
  if (!el) throw new Error(`section #${id} did not render`);
  return el;
}

describe("integration catalogue — real provider shapes", () => {
  it("renders the held support catalogue, whose rows carry no category", async () => {
    const { container, root } = await mount();
    try {
      const support = section(container, "ic-support");
      const text = support.textContent ?? "";
      expect(text).toContain("Zendesk");
      expect(text).toContain("Intercom");
      expect(text).toContain("Help Scout");
      expect(text).toContain("3 · 3 held");
      expect(text).toContain("Connecting is paused in this release");
      expect(text).not.toContain("could not be loaded");
      expect(text).not.toContain("undefined");
      // One row per provider: the rows are keyed by the provider key.
      expect(support.querySelectorAll("li")).toHaveLength(3);
    } finally {
      unmount(root);
    }
  });

  it("renders a provider row that omits category and auth mode", async () => {
    const { container, root } = await mount();
    try {
      const leads = section(container, "ic-leads");
      const rows = [...leads.querySelectorAll("li")];
      expect(rows).toHaveLength(2);
      expect(rows[0]?.textContent).toContain("lead capture · api token ref");
      expect(rows[1]?.textContent).toContain("Tally");
      expect(rows[1]?.textContent).not.toContain("undefined");
      expect(rows[1]?.textContent).not.toContain("·");
    } finally {
      unmount(root);
    }
  });

  it("treats a support body outside the held projection as a failed read, not a list", async () => {
    const { container, root } = await mount({
      ...SUPPORT_PROVIDERS,
      items: [{ ...SUPPORT_PROVIDERS.items[0], runtime_status: "partial" }],
    });
    try {
      const text = section(container, "ic-support").textContent ?? "";
      expect(text).toContain("Customer support could not be loaded");
      expect(text).not.toContain("Zendesk");
    } finally {
      unmount(root);
    }
  });
});
