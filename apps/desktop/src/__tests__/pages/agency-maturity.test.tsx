// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
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

const TENANT_A = "47000000-0000-4000-8000-000000000099";
const TENANT_B = "47000000-0000-4000-8000-000000000088";

function child(
  suffix: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `47000000-0000-4000-8000-0000000000${suffix}`,
    slug: `client-${suffix}`,
    name: `Client ${suffix}`,
    tier: "studio",
    parent_tenant_id: TENANT_A,
    billing_mode: "parent",
    reseller_markup_bps: 1250,
    whitelabel_enabled: true,
    created_at: "2026-09-10T03:04:05.000Z",
    updated_at: "2026-09-11T04:05:06.000Z",
    ...overrides,
  };
}

const CHILD_A = child("01");
const CHILD_B = child("02", {
  slug: "client-02",
  name: "Client 02",
  billing_mode: "self",
  reseller_markup_bps: 0,
  whitelabel_enabled: false,
});

const BRANDING = {
  whitelabel_enabled: true,
  brand_name: "Northstar Partner Cloud",
  custom_domain: "clients.northstar.co",
  logo_url: "https://assets.northstar.co/mark.svg",
  primary_color: "#7c183e",
  support_email: "support@northstar.example",
  legal_entity: "Northstar Media Ltd.",
  updated_at: "2026-09-11T05:06:07.123456Z",
  etag: `"agency-branding:${TENANT_A}:v7"`,
};

const mocks = vi.hoisted(() => ({
  initialTab: "children" as "children" | "branding" | "invoice",
  roleStatus: "resolved" as "loading" | "resolved" | "unavailable",
  me: {
    user: "47000000-0000-4000-8000-000000000010",
    tenant: "47000000-0000-4000-8000-000000000099",
    credentialSource: "session" as "session" | "api-key" | undefined,
    credentialFingerprint: null as string | null,
    webhookPlaygroundRecoveryScope: null as string | null,
    role: "admin" as const,
    effectiveRole: "admin" as "admin" | "editor" | "viewer",
    telemetryIdentity: null,
    noteRecoveryPrincipal: null,
  },
  loadMe: vi.fn(),
  listChildren: vi.fn(),
  createChild: vi.fn(),
  unlinkChild: vi.fn(),
  getBranding: vi.fn(),
  updateBranding: vi.fn(),
  invoicePreview: vi.fn(),
  setBillingMode: vi.fn(),
  available: vi.fn(),
  fromApiError: vi.fn(),
  partialPlanRequired: vi.fn(),
  navigateDesktopRoute: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  getApiUrl: () => "https://api.example.test/gateway",
  api: {
    agencyListChildren: mocks.listChildren,
    agencyCreateChild: mocks.createChild,
    agencyUnlinkChild: mocks.unlinkChild,
    agencyGetBranding: mocks.getBranding,
    agencyUpdateBranding: mocks.updateBranding,
    agencyInvoicePreview: mocks.invoicePreview,
    agencySetBillingMode: mocks.setBillingMode,
  },
}));

vi.mock("../../lib/store", () => ({
  useMe: () => mocks.me,
  useRoleStatus: () => mocks.roleStatus,
  loadMe: mocks.loadMe,
}));

vi.mock("../../lib/capability-observations", () => ({
  useCapabilityReporter: () => ({
    available: mocks.available,
    fromApiError: mocks.fromApiError,
    partialPlanRequired: mocks.partialPlanRequired,
  }),
}));

vi.mock("../../lib/desktop-router", async () => {
  const React = await import("react");
  return {
    useDesktopRouteTab: () => React.useState(mocks.initialTab),
    navigateDesktopRoute: mocks.navigateDesktopRoute,
  };
});

vi.mock("../../lib/heroAssets", () => ({
  HERO: { agency: "agency.webp" },
}));

import {
  contrastPairFor,
  parseAgencyBranding,
  parseAgencyChildren,
  safePublicHttpsLogoUrl,
} from "../../components/agency/agency-maturity";
import { Agency } from "../../pages/Agency";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.initialTab = "children";
  mocks.roleStatus = "resolved";
  mocks.me = {
    user: "47000000-0000-4000-8000-000000000010",
    tenant: TENANT_A,
    credentialSource: "session",
    credentialFingerprint: null,
    webhookPlaygroundRecoveryScope: null,
    role: "admin",
    effectiveRole: "admin",
    telemetryIdentity: null,
    noteRecoveryPrincipal: null,
  };
  mocks.listChildren.mockResolvedValue({
    data: {
      children: [CHILD_A],
      count: 1,
      has_more: false,
    },
  });
  mocks.getBranding.mockResolvedValue({ data: BRANDING });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

async function renderAgency(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Agency />));
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function click(label: string): void {
  act(() => button(label).click());
}

describe("Agency route maturity", () => {
  it("strictly decodes bounded roster pages and branding provenance", () => {
    const terminal = { children: [CHILD_A], count: 1, has_more: false };
    const continued = {
      children: [CHILD_A],
      count: 1,
      has_more: true,
      next_cursor: "eyJpZCI6ImN1cnNvci0xIn0",
    };
    expect(parseAgencyChildren(terminal)).toEqual(terminal);
    expect(parseAgencyChildren(continued)).toEqual(continued);
    expect(
      parseAgencyChildren({ ...terminal, next_cursor: "unexpected" }),
    ).toBeNull();
    expect(
      parseAgencyChildren({ ...continued, next_cursor: undefined }),
    ).toBeNull();
    expect(parseAgencyChildren({ ...terminal, future: true })).toBeNull();
    const oversized = Array.from({ length: 201 }, (_, index) => ({
      ...CHILD_A,
      id: `47000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      slug: `client-${index + 1}`,
    }));
    expect(
      parseAgencyChildren({
        children: oversized,
        count: oversized.length,
        has_more: false,
      }),
    ).toBeNull();
    expect(
      parseAgencyChildren({
        ...terminal,
        children: [CHILD_A, { ...CHILD_A }],
        count: 2,
      }),
    ).toBeNull();
    expect(
      parseAgencyChildren({
        ...terminal,
        children: [{ ...CHILD_A, parent_tenant_id: "not-a-uuid" }],
      }),
    ).toBeNull();

    expect(parseAgencyBranding(BRANDING)).toEqual(BRANDING);
    expect(parseAgencyBranding({ ...BRANDING, future: true })).toBeNull();
    expect(parseAgencyBranding({ ...BRANDING, etag: "weak" })).toBeNull();
    expect(
      parseAgencyBranding({ ...BRANDING, brand_name: "spoof\u202evalue" }),
    ).toBeNull();
    expect(
      parseAgencyBranding({ ...BRANDING, logo_url: "https://127.1/logo.svg" }),
    ).toBeNull();
  });

  it("renders a bounded roster without any portfolio-total or invoice claim", async () => {
    mocks.listChildren.mockResolvedValueOnce({
      data: {
        children: [CHILD_A],
        count: 1,
        has_more: true,
        next_cursor: "page_two",
      },
    });
    await renderAgency();

    const loadedCard = Array.from(
      document.querySelectorAll<HTMLElement>(".agency-stat-card"),
    ).find((candidate) => candidate.textContent?.includes("Loaded workspaces"));
    expect(loadedCard?.querySelector("strong")?.textContent).toBe("1");
    expect(document.body.textContent).toContain(
      "Current cursor window · more available",
    );
    expect(document.body.textContent).toContain(String(CHILD_A.id));
    expect(document.body.textContent).toContain(String(CHILD_A.updated_at));
    expect(document.body.textContent).toContain("not payer proof");
    expect(document.body.textContent).not.toContain("1 total");
    expect(mocks.invoicePreview).not.toHaveBeenCalled();
    expect(document.querySelector("[title]")).toBeNull();

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("deduplicates overlap and retains loaded pages through a failed continuation", async () => {
    mocks.listChildren
      .mockResolvedValueOnce({
        data: {
          children: [CHILD_A],
          count: 1,
          has_more: true,
          next_cursor: "page_two",
        },
      })
      .mockResolvedValueOnce({
        error: {
          kind: "http",
          status: 503,
          code: "agency_store_failed",
          requestId: "REQ-47-PAGE-2",
          message: "private database topology",
        },
      })
      .mockResolvedValueOnce({
        data: {
          children: [CHILD_A, CHILD_B],
          count: 2,
          has_more: false,
        },
      });
    await renderAgency();

    click("Load next page");
    await flush();
    expect(document.body.textContent).toContain("REQ-47-PAGE-2");
    expect(document.body.textContent).not.toContain("private database");
    expect(document.body.textContent).toContain(String(CHILD_A.id));
    expect(button("Retry next page")).toBeTruthy();

    click("Retry next page");
    await flush();
    expect(document.body.textContent).toContain(String(CHILD_B.id));
    expect(document.querySelectorAll(".agency-table tbody tr")).toHaveLength(2);
    expect(document.body.textContent).toContain(
      "All 2 verified rows are loaded",
    );
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Load next page",
      ),
    ).toBe(false);
    expect(mocks.listChildren).toHaveBeenNthCalledWith(2, {
      limit: 200,
      cursor: "page_two",
      signal: expect.any(AbortSignal),
    });
    expect(mocks.listChildren).toHaveBeenNthCalledWith(3, {
      limit: 200,
      cursor: "page_two",
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects self-linked rows and conflicting overlap without replacing verified data", async () => {
    mocks.listChildren.mockResolvedValueOnce({
      data: {
        children: [
          {
            ...CHILD_A,
            id: TENANT_A,
            slug: "self-linked",
          },
        ],
        count: 1,
        has_more: false,
      },
    });
    await renderAgency();
    expect(document.querySelector(".agency-table")).toBeNull();
    expect(document.body.textContent).toContain(
      "invalid_agency_children_response",
    );

    act(() => root?.unmount());
    root = createRoot(container as HTMLDivElement);
    mocks.listChildren
      .mockResolvedValueOnce({
        data: {
          children: [CHILD_A],
          count: 1,
          has_more: true,
          next_cursor: "page_two",
        },
      })
      .mockResolvedValueOnce({
        data: {
          children: [{ ...CHILD_A, name: "Conflicting identity" }],
          count: 1,
          has_more: false,
        },
      });
    await renderAgency();
    click("Load next page");
    await flush();
    expect(document.body.textContent).toContain(String(CHILD_A.name));
    expect(document.body.textContent).not.toContain("Conflicting identity");
    expect(document.querySelectorAll(".agency-table tbody tr")).toHaveLength(1);
    expect(document.body.textContent).toContain(
      "invalid_agency_roster_continuation",
    );
  });

  it("rejects a self-linked continuation without replacing verified rows", async () => {
    mocks.listChildren
      .mockResolvedValueOnce({
        data: {
          children: [CHILD_A],
          count: 1,
          has_more: true,
          next_cursor: "page_two",
        },
      })
      .mockResolvedValueOnce({
        data: {
          children: [
            {
              ...CHILD_B,
              id: TENANT_A,
              slug: "self-linked-tail",
            },
          ],
          count: 1,
          has_more: false,
        },
      });
    await renderAgency();

    click("Load next page");
    await flush();

    expect(document.body.textContent).toContain(String(CHILD_A.name));
    expect(document.body.textContent).not.toContain("self-linked-tail");
    expect(document.querySelectorAll(".agency-table tbody tr")).toHaveLength(1);
    expect(document.body.textContent).toContain(
      "invalid_agency_roster_continuation",
    );
  });

  it("retains every loaded page when a first-page refresh fails", async () => {
    mocks.listChildren
      .mockResolvedValueOnce({
        data: {
          children: [CHILD_A],
          count: 1,
          has_more: true,
          next_cursor: "page_two",
        },
      })
      .mockResolvedValueOnce({
        data: { children: [CHILD_B], count: 1, has_more: false },
      })
      .mockResolvedValueOnce({
        error: {
          kind: "http",
          status: 503,
          code: "refresh_failed",
          requestId: "REQ-47-REFRESH",
          message: "private refresh detail",
        },
      });
    await renderAgency();
    click("Load next page");
    await flush();
    click("Refresh roster");
    await flush();

    expect(document.body.textContent).toContain(String(CHILD_A.id));
    expect(document.body.textContent).toContain(String(CHILD_B.id));
    expect(document.body.textContent).toContain(
      "Showing last verified sub-accounts",
    );
    expect(document.body.textContent).toContain("REQ-47-REFRESH");
    expect(document.body.textContent).not.toContain("private refresh detail");
  });

  it("keeps every unsafe affordance discoverable, described, and request-free", async () => {
    await renderAgency();
    for (const label of ["New sub-account", "Change billing", "Unlink"]) {
      const held = button(label);
      expect(held.disabled).toBe(false);
      expect(held.getAttribute("aria-disabled")).toBe("true");
      expect(held.getAttribute("aria-describedby")).toBeTruthy();
      act(() => held.click());
    }
    click("Usage & invoices");
    await flush();
    for (const label of [
      "Refresh invoice projection",
      "Preview usage",
      "Change billing owner",
      "Export invoice",
    ]) {
      act(() => button(label).click());
    }

    expect(document.querySelectorAll("[data-agency-held-control]").length).toBe(
      7,
    );
    expect(mocks.createChild).not.toHaveBeenCalled();
    expect(mocks.unlinkChild).not.toHaveBeenCalled();
    expect(mocks.setBillingMode).not.toHaveBeenCalled();
    expect(mocks.invoicePreview).not.toHaveBeenCalled();
    expect(mocks.updateBranding).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain(
      "this tab sends no invoice-preview request",
    );
  });

  it("shows exact read-only branding provenance and never calls a writer", async () => {
    mocks.initialTab = "branding";
    await renderAgency();

    expect(mocks.getBranding).toHaveBeenCalledTimes(1);
    expect(mocks.getBranding.mock.calls[0]?.[0]).toMatchObject({
      expectedTenantId: TENANT_A,
    });
    expect(document.body.textContent).toContain(BRANDING.updated_at);
    expect(document.body.textContent).toContain(BRANDING.etag);
    expect(document.body.textContent).toContain(
      "only to the audit-portal branding projection",
    );
    expect(document.body.textContent?.toLowerCase()).toContain(
      "no current reader consumes",
    );
    expect(
      document.querySelectorAll(".agency-branding-form input"),
    ).toHaveLength(0);
    expect(document.querySelector(".agency-branding-form")?.tagName).toBe("DL");
    act(() => button("Change branding").click());
    expect(mocks.updateBranding).not.toHaveBeenCalled();
    expect(document.querySelector(".agency-brand-preview img")).toBeNull();
    expect(document.body.textContent).toContain("External logo not loaded");

    click("Workspace brand");
    expect(mocks.navigateDesktopRoute).toHaveBeenCalledWith({
      section: "settings",
      settingsAnchor: "workspace-profile",
    });
  });

  it("retains the verified branding record when refresh fails", async () => {
    mocks.initialTab = "branding";
    mocks.getBranding
      .mockResolvedValueOnce({ data: BRANDING })
      .mockResolvedValueOnce({
        error: {
          kind: "http",
          status: 503,
          code: "branding_read_failed",
          requestId: "REQ-47-BRAND",
          message: "private branding storage",
        },
      });
    await renderAgency();
    click("Refresh branding");
    await flush();

    expect(document.body.textContent).toContain(BRANDING.brand_name);
    expect(document.body.textContent).toContain(
      "Showing last verified agency branding",
    );
    expect(document.body.textContent).toContain("REQ-47-BRAND");
    expect(document.body.textContent).not.toContain("private branding storage");
  });

  it("implements manual APG tabs with one selected and one tabbable tab", async () => {
    await renderAgency();
    const tabs = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const [childrenTab, brandingTab] = tabs;
    if (!childrenTab || !brandingTab) throw new Error("Missing agency tabs");
    act(() => childrenTab.focus());
    act(() => {
      childrenTab.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(brandingTab);
    expect(childrenTab.getAttribute("aria-selected")).toBe("true");
    expect(brandingTab.getAttribute("aria-selected")).toBe("false");
    act(() => {
      brandingTab.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await flush();
    expect(brandingTab.getAttribute("aria-selected")).toBe("true");
    expect(
      document.querySelectorAll('[role="tab"][tabindex="0"]'),
    ).toHaveLength(1);
    const panelId = brandingTab.getAttribute("aria-controls");
    expect(document.getElementById(panelId ?? "")?.hidden).toBe(false);
  });

  it("makes viewer and unresolved credential authority zero-request boundaries", async () => {
    mocks.me.effectiveRole = "viewer";
    await renderAgency();
    expect(document.body.textContent).toContain(
      "Workspace admin access required",
    );
    expect(document.body.textContent).toContain("No agency request was made");
    expect(mocks.listChildren).not.toHaveBeenCalled();
    expect(mocks.getBranding).not.toHaveBeenCalled();
    expect(document.querySelector('[role="tablist"]')).toBeNull();

    mocks.me.effectiveRole = "admin";
    mocks.me.credentialSource = "api-key";
    mocks.me.credentialFingerprint = null;
    mocks.me.webhookPlaygroundRecoveryScope = null;
    act(() => root?.render(<Agency />));
    await flush();
    expect(document.body.textContent).toContain(
      "Credential identity could not be verified",
    );
    expect(mocks.listChildren).not.toHaveBeenCalled();
    click("Retry access check");
    expect(mocks.loadMe).toHaveBeenCalledTimes(1);

    for (const identity of [
      { user: "not-a-principal", tenant: TENANT_A },
      { user: mocks.me.user, tenant: "not-a-tenant" },
    ]) {
      mocks.me = {
        ...mocks.me,
        ...identity,
        credentialSource: "session",
        effectiveRole: "admin",
      };
      act(() => root?.render(<Agency />));
      await flush();
      expect(document.body.textContent).toContain(
        "Credential identity could not be verified",
      );
      expect(mocks.listChildren).not.toHaveBeenCalled();
      expect(mocks.getBranding).not.toHaveBeenCalled();
    }
  });

  it("accepts reviewed API-key identity and purges data on authority change", async () => {
    mocks.me.credentialSource = "api-key";
    mocks.me.webhookPlaygroundRecoveryScope = "a".repeat(64);
    await renderAgency();
    expect(document.body.textContent).toContain(String(CHILD_A.name));
    expect(mocks.listChildren).toHaveBeenCalledTimes(1);

    mocks.me.effectiveRole = "viewer";
    act(() => root?.render(<Agency />));
    expect(document.body.textContent).toContain(
      "Workspace admin access required",
    );
    expect(document.body.textContent).not.toContain(String(CHILD_A.name));
    expect(document.querySelector(".agency-table")).toBeNull();
  });

  it("remounts for an exact tenant change and does not retain the old roster", async () => {
    await renderAgency();
    expect(document.body.textContent).toContain(String(CHILD_A.name));
    const next = child("03", {
      name: "Tenant B Client",
      slug: "tenant-b-client",
      parent_tenant_id: TENANT_B,
    });
    mocks.me = { ...mocks.me, tenant: TENANT_B };
    mocks.listChildren.mockResolvedValueOnce({
      data: { children: [next], count: 1, has_more: false },
    });
    act(() => root?.render(<Agency />));
    expect(document.body.textContent).not.toContain(String(CHILD_A.name));
    await flush();
    expect(document.body.textContent).toContain(String(next.name));
    expect(mocks.listChildren).toHaveBeenCalledTimes(2);
  });

  it("chooses the higher-contrast foreground and rejects tracking/local logo URLs", () => {
    expect(contrastPairFor("#ffffff")).toMatchObject({
      foregroundName: "black",
      ratio: 21,
    });
    expect(contrastPairFor("#000000")).toMatchObject({
      foregroundName: "white",
      ratio: 21,
    });
    for (const url of [
      "https://localhost/logo.png",
      "https://127.1/logo.png",
      "https://8.8.8.8/logo.png",
      "https://assets.example/logo.png",
      "https://assets.northstar.co/logo%0a.png",
    ]) {
      expect(safePublicHttpsLogoUrl(url)).toBeNull();
    }
    expect(
      safePublicHttpsLogoUrl("https://cdn.northstar.co/logo.png?tenant=secret"),
    ).toBeNull();
    expect(
      safePublicHttpsLogoUrl("https://cdn.northstar.co/logo.png#tracking"),
    ).toBeNull();
    expect(safePublicHttpsLogoUrl("https://cdn.northstar.co/logo.png")).toBe(
      "https://cdn.northstar.co/logo.png",
    );
  });
});
