// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Section } from "../../lib/store";

const mocks = vi.hoisted(() => ({
  section: "campaigns" as Section,
  setSection: vi.fn(),
  getMe: vi.fn().mockResolvedValue({
    data: { user: "owner@example.test", tenant: "Acme" },
  }),
  getApiKeySelfInfo: vi.fn().mockResolvedValue({ data: undefined }),
}));

vi.mock("../../lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/store")>();
  return {
    ...actual,
    useSection: () => mocks.section,
    useMe: () => ({
      user: "owner@example.test",
      tenant: "Acme",
      role: "admin",
      effectiveRole: "admin",
    }),
    setSection: mocks.setSection,
  };
});
vi.mock("../../lib/api-client", () => ({
  api: {
    getMe: mocks.getMe,
    getApiKeySelfInfo: mocks.getApiKeySelfInfo,
  },
}));
vi.mock("../../lib/auditScopes", () => ({
  useAuditScopes: () => ({
    loading: false,
    isAdmin: false,
    scopes: new Set<string>(),
  }),
}));
vi.mock("../../hooks/useSidebarCallout", () => ({
  useSidebarCallout: () => null,
}));
vi.mock("../../components/NewBadge", () => ({ NewBadge: () => null }));
vi.mock("../../components/SidebarCallout", () => ({
  SidebarCallout: () => null,
}));
vi.mock("../../components/WorkspaceMenu", () => ({
  WorkspaceMenu: () => null,
}));

import { Sidebar } from "../../components/Sidebar";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  localStorage.clear();
  mocks.setSection.mockReset();
  mocks.section = "campaigns";
  mocks.getMe.mockReset();
  mocks.getMe.mockResolvedValue({
    data: { user: "owner@example.test", tenant: "Acme" },
  });
  mocks.getApiKeySelfInfo.mockReset();
  mocks.getApiKeySelfInfo.mockResolvedValue({ data: undefined });
});

async function render(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Sidebar />);
    await Promise.all([
      import("../../lib/capability-access"),
      import("../../lib/capability-observations"),
      import("../../lib/navigation-preferences"),
      import("../../components/SidebarDomainNavigation"),
    ]);
    await Promise.resolve();
  });
}

describe("Sidebar navigation semantics", () => {
  it("shows the API-key actor instead of a false signed-out label", async () => {
    mocks.getMe.mockResolvedValue({
      data: { user: "", tenant: "postwave-demo" },
    });
    mocks.getApiKeySelfInfo.mockResolvedValue({
      data: {
        tenant_id: "tenant_1",
        tenant_slug: "postwave-demo",
        scopes: ["admin"],
        actor: "Local desktop demo",
      },
    });

    await render();

    expect(document.querySelector(".sidebar-account-email")?.textContent).toBe(
      "Local desktop demo",
    );
  });

  it("accounts for every destination with stable ids, groups, and current state", async () => {
    await render();
    expect(
      document.querySelector('aside[aria-label="Application sidebar"]'),
    ).not.toBeNull();
    expect(document.querySelector('nav[aria-label="Primary"]')).not.toBeNull();
    expect(document.querySelectorAll(".sidebar-domain")).toHaveLength(9);
    expect(
      document.querySelectorAll<HTMLButtonElement>("[data-section]"),
    ).toHaveLength(55);

    const campaignDestinations = document.querySelectorAll<HTMLButtonElement>(
      '[data-section="campaigns"]',
    );
    expect(campaignDestinations).toHaveLength(2);
    expect(
      [...campaignDestinations].some((destination) =>
        destination.closest(".sidebar-section-promoted"),
      ),
    ).toBe(true);
    expect(
      [...campaignDestinations].some((destination) =>
        destination.closest(".sidebar-domain"),
      ),
    ).toBe(true);

    const current = [...campaignDestinations].find((destination) =>
      destination.closest(".sidebar-domain"),
    );
    expect(current?.getAttribute("aria-current")).toBe("page");
    expect(
      document.querySelector('nav[aria-label="Primary"] [title]'),
    ).toBeNull();
    const firstDomainToggle = document.querySelector<HTMLButtonElement>(
      ".sidebar-domain-toggle",
    );
    const domainDescriptionId =
      firstDomainToggle?.getAttribute("aria-describedby");
    expect(
      document.getElementById(domainDescriptionId!)?.textContent?.trim(),
    ).not.toBe("");
    act(() => current?.click());
    expect(mocks.setSection).toHaveBeenCalledWith("campaigns");
  });

  it("keeps restricted destinations discoverable and routes to the shared explanation", async () => {
    await render();
    const audit = document.querySelector<HTMLButtonElement>(
      '[data-section="audit"]',
    );
    expect(audit?.getAttribute("aria-disabled")).toBeNull();
    expect(audit?.textContent).toContain("Access required");
    const accessReasonId = audit?.getAttribute("aria-describedby");
    expect(document.getElementById(accessReasonId!)?.textContent).toContain(
      "audit",
    );
    act(() => audit?.click());
    expect(mocks.setSection).toHaveBeenCalledWith("audit");
  });
});
