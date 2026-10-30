// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Reachability for the audience policy editors (parity rows audience-43/44/45):
// each verb's component is asserted in isolation elsewhere; this proves each
// is actually mounted on its page, fed by the page's own query, and that the
// page does not leak an admin-only read to a role the card withholds it from.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";

const mocks = vi.hoisted(() => ({ whoami: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children }: { href: string; children: unknown }) =>
      createElement("a", { href }, children as never),
  };
});
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

const VERSION = `sha256:${"d".repeat(64)}`;

const BODIES: Record<string, unknown> = {
  "/api/v1/sunset/policies": {
    items: [
      {
        id: "pol_1",
        name: "Two-year sunset",
        inactiveDays: 730,
        action: "tag",
        enabled: false,
        excludedTags: [],
      },
    ],
  },
  "/api/v1/scoring/rules": {
    rules: [{ id: "r1", event_type: "clicked", weight: 4 }],
    defaults: [
      { id: "", event_type: "clicked", weight: 5 },
      { id: "", event_type: "opened", weight: 1 },
    ],
    event_catalog: [
      { event_type: "clicked", label: "Clicked", category: "engagement" },
      { event_type: "opened", label: "Opened", category: "engagement" },
    ],
    version: VERSION,
    window_days: 90,
  },
  "/api/v1/merge-fields/schema": {
    items: [
      {
        tenant_id: WHOAMI.tenant_id,
        key: "FNAME",
        label: "First name",
        type: "text",
        default_value: "",
        required: false,
        position: 0,
        value_count: 0,
        created_at: "2026-08-01T09:00:00Z",
        updated_at: "2026-08-01T09:00:00Z",
      },
    ],
  },
};

const requested: string[] = [];

beforeEach(() => {
  requested.length = 0;
  mocks.whoami.mockReset();
  mocks.whoami.mockResolvedValue(WHOAMI);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
      requested.push(path);
      const body = BODIES[path];
      return body === undefined
        ? new Response(
            JSON.stringify({ error: { code: "not_found", message: "" } }),
            { status: 404, headers: { "content-type": "application/json" } },
          )
        : new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function buttonNamed(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  );
}

describe("audience policy editors are reachable from their pages", () => {
  it("list hygiene mounts the sunset card on the page's own policy read", async () => {
    const Page = (await import("@/app/(dashboard)/app/list-hygiene/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      const card = container.querySelector('[data-testid="sunset-policies"]');
      expect(card?.textContent).toContain("Two-year sunset");
      expect(card?.textContent).toContain("Inactive ≥ 730 days → Tag for review");
      expect(buttonNamed(container, "New policy")?.disabled).toBe(false);
      // One read, shared by the page and the card.
      expect(
        requested.filter((path) => path === "/api/v1/sunset/policies"),
      ).toHaveLength(1);
    } finally {
      unmount(root);
    }
  });

  it("list hygiene never requests the admin-only policy list for an editor, even on refresh", async () => {
    mocks.whoami.mockResolvedValue({
      ...WHOAMI,
      role: "editor",
      effective_role: "editor",
    });
    const Page = (await import("@/app/(dashboard)/app/list-hygiene/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      const { act } = await import("react");
      await act(async () => {
        buttonNamed(container, "Refresh hygiene")?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(requested).not.toContain("/api/v1/sunset/policies");
      expect(container.textContent).toContain(
        "Sunset policies need owner or admin access.",
      );
      expect(buttonNamed(container, "New policy")?.disabled).toBe(true);
    } finally {
      unmount(root);
    }
  });

  it("developer reference mounts the audience-field editor on the page's own schema read", async () => {
    const Page = (await import("@/app/(dashboard)/app/developer-reference/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      const launcher = buttonNamed(container, "Edit audience fields");
      expect(launcher?.disabled).toBe(false);
      const { act } = await import("react");
      await act(async () => {
        launcher?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const modal = document.querySelector(
        '[data-testid="merge-fields-schema-modal"]',
      );
      expect(modal?.querySelector('[data-field-key="FNAME"]')).not.toBeNull();
      // The page's list and the editor share one schema read.
      expect(
        requested.filter((path) => path === "/api/v1/merge-fields/schema"),
      ).toHaveLength(1);
    } finally {
      unmount(root);
    }
  });

  it("scoring mounts the rules editor on the page's own rules read", async () => {
    const Page = (await import("@/app/(dashboard)/app/scoring/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      const editor = container.querySelector(
        '[data-testid="scoring-rules-editor"]',
      );
      expect(
        editor?.querySelector<HTMLInputElement>('[aria-label="Rule 1 weight"]')
          ?.value,
      ).toBe("4");
      expect(
        requested.filter((path) => path === "/api/v1/scoring/rules"),
      ).toHaveLength(1);
      // One custom rule means the defaults are NOT in force.
      expect(container.textContent).toContain(
        "The built-in weights are not applied while any custom rule exists",
      );
    } finally {
      unmount(root);
    }
  });
});
