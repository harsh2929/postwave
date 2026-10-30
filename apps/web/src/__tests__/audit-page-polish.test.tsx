// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// governance-2 / 7 / 9 / 16 / 19: the audit page's freshness, one-click
// scoping and metadata-reading verbs. Each verb is asserted by the request it
// sends (path + query, through the one transport every client shares) and by
// what the page shows afterwards — never by a button merely existing.

import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  whoami: vi.fn(),
  getAuditCapabilities: vi.fn(),
  listAuditAccessRequests: vi.fn(),
  listAuditSavedViews: vi.fn(),
  replace: vi.fn(),
  // The URL the page mounts with; a test that needs a deep-linked filter sets
  // it before rendering.
  search: "",
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: mocks.get } };
});

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/audit-saved-views-access-api", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/audit-saved-views-access-api")
  >()),
  getAuditCapabilities: mocks.getAuditCapabilities,
  listAuditAccessRequests: mocks.listAuditAccessRequests,
  listAuditSavedViews: mocks.listAuditSavedViews,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.replace }),
  usePathname: () => "/app/settings/audit",
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

import AuditLogPage from "@/app/(dashboard)/app/settings/audit/page";
import { AuditDetailDialog } from "@/app/(dashboard)/app/settings/audit/audit-detail-dialog";
import {
  countAuditLog,
  redactAuditMetadata,
  type AuditRow,
} from "@/lib/audit-api";
import { qk } from "@/lib/query-keys";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN_ID = "5f0d2ac4-1111-4b2c-9d3e-000000000001";

const FEED_ROWS: AuditRow[] = [
  {
    id: 101,
    action: "campaign.updated",
    resourceType: "campaign",
    resourceId: CAMPAIGN_ID,
    actorType: "human",
    actorLabel: "ada@example.com",
    ip: "203.0.113.7",
    metadata: {
      context: { correlation_id: "web-01/AbC-7" },
      before: { subject: "Spring sale", status: "draft" },
      after: { subject: "Spring SALE", status: "draft" },
    },
    at: "2026-08-04T10:00:00.000Z",
  },
  {
    id: 90,
    action: "retention.pruned",
    resourceType: "audit_log",
    actorType: "system",
    metadata: { after: { deleted: 12 } },
    at: "2026-08-04T09:00:00.000Z",
  },
];

function render(ui: ReactNode): { root: Root; queryClient: QueryClient } {
  // gcTime Infinity: a test seeds a query nobody observes (the forensics
  // panel's statistics) and must still find it after the refresh.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
  return { root, queryClient };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flush();
      });
    }
  }
  throw lastError;
}

async function click(el: HTMLElement | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    el?.click();
    await flush();
  });
}

function buttonsByText(text: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button")).filter(
    (b): b is HTMLButtonElement =>
      b instanceof HTMLButtonElement && b.textContent?.trim() === text,
  );
}

/** Body text with runs of whitespace collapsed, so JSX line breaks don't hide a match. */
function bodyText(): string {
  return (document.body.textContent ?? "").replace(/\s+/g, " ");
}

/** Every GET the page has sent, as "/path?query" — the contract under test. */
function getPaths(): string[] {
  return mocks.get.mock.calls.map((call) => String(call[0]));
}

/**
 * Replace ONLY navigator.clipboard. Stubbing the whole navigator object breaks
 * React's own rendering (it reads userAgent).
 */
function setClipboard(clipboard: unknown): void {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: clipboard,
    configurable: true,
    writable: true,
  });
}

function serveAudit(
  count: () => Promise<unknown> = async () => ({
    totalEstimate: 2400,
    confidence: "approximate",
  }),
): void {
  mocks.get.mockImplementation(async (path: string) => {
    const url = new URL(path, "https://app.example.test");
    if (url.pathname === "/api/v1/audit") return { rows: FEED_ROWS };
    if (url.pathname === "/api/v1/audit/count") return count();
    throw new Error(`unmocked GET ${path}`);
  });
}

beforeEach(() => {
  mocks.search = "";
  mocks.listAuditAccessRequests.mockResolvedValue([]);
  mocks.listAuditSavedViews.mockResolvedValue([]);
  mocks.whoami.mockResolvedValue({
    id: "11111111-1111-7111-8111-111111111111",
    email: "admin@example.test",
    tenant_id: TENANT,
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
  });
  mocks.getAuditCapabilities.mockResolvedValue({
    scopes: ["audit:read", "audit:read_pii", "audit:execute_actions"],
    auditScopes: ["audit:read", "audit:read_pii", "audit:execute_actions"],
    isAdmin: true,
  });
  serveAudit();
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  setClipboard(undefined);
});

async function mountPage(): Promise<{ root: Root; queryClient: QueryClient }> {
  const mounted = render(createElement(AuditLogPage));
  await waitFor(() => {
    expect(bodyText()).toContain("retention.pruned");
  });
  return mounted;
}

describe("countAuditLog", () => {
  it("sends only the parameters the count route reads", async () => {
    mocks.get.mockResolvedValue({ totalEstimate: 3, confidence: "exact" });
    await countAuditLog({
      actorType: "agent",
      action: "delete",
      resourceType: "campaign",
      resourceId: "abc",
      since: "2026-01-01T00:00:00.000Z",
      // List-paging concerns the handler ignores; sending them would only
      // suggest a precision the count does not have.
      until: "2026-02-01T00:00:00.000Z",
      limit: 50,
      cursor: "c9",
    });
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/audit/count?actor_type=agent&action=delete&resource_type=campaign&resource_id=abc&since=2026-01-01T00%3A00%3A00.000Z",
      expect.anything(),
    );
  });
});

describe("governance-2: Refresh now", () => {
  it("re-reads the list and the total, and marks the forensics statistics stale", async () => {
    const { root, queryClient } = await mountPage();
    try {
      // The first paint already reads both, and shows the total with the
      // server's confidence — a planner estimate is "~", not a number.
      expect(getPaths()).toContain("/api/v1/audit?limit=50");
      expect(getPaths()).toContain("/api/v1/audit/count");
      await waitFor(() => {
        expect(bodyText()).toMatch(/2 entries shown of ~2,?400 total/);
      });

      // The forensics panel owns the statistics query under its own key.
      // Seed one as if the panel had loaded it, then see the refresh reach it.
      const statsKey = [
        ...qk.settings(TENANT, "admin", "audit-forensics"),
        "stats",
        '["","","","","",""]',
      ];
      queryClient.setQueryData(statsKey, { totalEvents: 1 });
      expect(queryClient.getQueryState(statsKey)?.isInvalidated).toBe(false);

      mocks.get.mockClear();
      await click(buttonsByText("Refresh now")[0]);
      await waitFor(() => {
        expect(getPaths()).toEqual(
          expect.arrayContaining([
            "/api/v1/audit?limit=50",
            "/api/v1/audit/count",
          ]),
        );
      });
      expect(queryClient.getQueryState(statsKey)?.isInvalidated).toBe(true);
      await waitFor(() => {
        expect(bodyText()).toContain("Last refreshed");
      });
      expect(bodyText()).toContain("retention.pruned");
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps the last verified rows visible and says so when a refresh fails", async () => {
    const { root } = await mountPage();
    try {
      mocks.get.mockImplementation(async (path: string) => {
        throw new Error(`audit read refused: ${path}`);
      });
      await click(buttonsByText("Refresh now")[0]);
      await waitFor(() => {
        expect(bodyText()).toContain(
          "Refresh failed. Last verified rows remain visible",
        );
      });
      // The failure did not blank the feed into "nothing happened".
      expect(bodyText()).toContain("retention.pruned");
      expect(bodyText()).not.toContain("No audit entries match");
    } finally {
      act(() => root.unmount());
    }
  });

  it("withholds the total while a To date is set, because the count route has no until", async () => {
    mocks.search = "until=2026-02-01T00%3A00%3A00.000Z";
    const { root } = await mountPage();
    try {
      expect(getPaths()).toContain(
        "/api/v1/audit?until=2026-02-01T00%3A00%3A00.000Z&limit=50",
      );
      expect(getPaths().some((p) => p.startsWith("/api/v1/audit/count"))).toBe(
        false,
      );
      expect(bodyText()).toContain(
        "Totals are not counted for a bounded To date.",
      );
      mocks.get.mockClear();
      await click(buttonsByText("Refresh now")[0]);
      await waitFor(() => {
        expect(getPaths()).toContain(
          "/api/v1/audit?until=2026-02-01T00%3A00%3A00.000Z&limit=50",
        );
      });
      expect(getPaths().some((p) => p.startsWith("/api/v1/audit/count"))).toBe(
        false,
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("says when the total could not be counted instead of showing a zero", async () => {
    serveAudit(async () => {
      throw new Error("audit count is unavailable");
    });
    const { root } = await mountPage();
    try {
      await waitFor(() => {
        expect(bodyText()).toContain(
          "Total count unavailable (audit count is unavailable).",
        );
      });
      expect(bodyText()).not.toMatch(/of 0 total/);
      expect(bodyText()).toContain("retention.pruned");
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("governance-7: AI activity chip", () => {
  it("pivots the actor filter to agent with one click, and lifts it with another", async () => {
    const { root } = await mountPage();
    try {
      const chip = buttonsByText("AI activity")[0];
      expect(chip?.getAttribute("aria-pressed")).toBe("false");

      mocks.get.mockClear();
      await click(chip);
      await waitFor(() => {
        expect(getPaths()).toContain(
          "/api/v1/audit?actor_type=agent&limit=50",
        );
      });
      // The total follows the same filter.
      expect(getPaths()).toContain("/api/v1/audit/count?actor_type=agent");
      expect(chip?.getAttribute("aria-pressed")).toBe("true");
      // The dropdown reflects the pivot: the chip is a shortcut to the same
      // filter, not a second one beside it.
      expect(
        document.querySelector<HTMLSelectElement>("#filter-actor-type")?.value,
      ).toBe("agent");

      mocks.get.mockClear();
      await click(chip);
      await waitFor(() => {
        expect(getPaths()).toContain("/api/v1/audit?limit=50");
      });
      expect(chip?.getAttribute("aria-pressed")).toBe("false");
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("governance-9: action-category chips", () => {
  it("applies one literal action substring per chip and clears on a second press", async () => {
    const { root } = await mountPage();
    try {
      mocks.get.mockClear();
      const auth = buttonsByText("Auth")[0];
      await click(auth);
      await waitFor(() => {
        expect(getPaths()).toContain("/api/v1/audit?action=login&limit=50");
      });
      expect(getPaths()).toContain("/api/v1/audit/count?action=login");
      expect(auth?.getAttribute("aria-pressed")).toBe("true");
      expect(
        document.querySelector<HTMLInputElement>("#filter-action")?.value,
      ).toBe("login");
      expect(bodyText()).toContain("Action contains “login”");

      mocks.get.mockClear();
      const reads = buttonsByText("Audit reads")[0];
      await click(reads);
      await waitFor(() => {
        expect(getPaths()).toContain(
          "/api/v1/audit?action=audit.read&limit=50",
        );
      });
      expect(auth?.getAttribute("aria-pressed")).toBe("false");
      expect(reads?.getAttribute("aria-pressed")).toBe("true");

      mocks.get.mockClear();
      await click(reads);
      await waitFor(() => {
        expect(getPaths()).toContain("/api/v1/audit?limit=50");
      });
      expect(reads?.getAttribute("aria-pressed")).toBe("false");
      expect(bodyText()).toContain("No action substring filter.");
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("governance-16: filter to this resource", () => {
  it("scopes the feed to one record from its row", async () => {
    const { root } = await mountPage();
    try {
      mocks.get.mockClear();
      await click(
        document.querySelector<HTMLButtonElement>(
          `button[aria-label="Filter to events touching ${CAMPAIGN_ID}"]`,
        ),
      );
      await waitFor(() => {
        expect(getPaths()).toContain(
          `/api/v1/audit?resource_type=campaign&resource_id=${CAMPAIGN_ID}&limit=50`,
        );
      });
      expect(getPaths()).toContain(
        `/api/v1/audit/count?resource_type=campaign&resource_id=${CAMPAIGN_ID}`,
      );
      expect(
        document.querySelector<HTMLInputElement>("#filter-resource-id")?.value,
      ).toBe(CAMPAIGN_ID);
      expect(
        document.querySelector<HTMLInputElement>("#filter-resource-type")
          ?.value,
      ).toBe("campaign");
    } finally {
      act(() => root.unmount());
    }
  });

  it("offers the same verb inside the entry dialog and closes into the filtered feed", async () => {
    const { root } = await mountPage();
    try {
      await click(
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="View audit entry campaign.updated"]',
        ),
      );
      await waitFor(() => {
        expect(buttonsByText("Filter to this resource")).toHaveLength(1);
      });
      mocks.get.mockClear();
      await click(buttonsByText("Filter to this resource")[0]);
      await waitFor(() => {
        expect(getPaths()).toContain(
          `/api/v1/audit?resource_type=campaign&resource_id=${CAMPAIGN_ID}&limit=50`,
        );
      });
      // Replaced, not stacked: the dialog gave way to the filtered feed.
      expect(buttonsByText("Filter to this resource")).toHaveLength(0);
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("governance-19: metadata Parsed / JSON + Copy JSON", () => {
  const ROW: AuditRow = {
    ...FEED_ROWS[0]!,
    metadata: {
      context: {
        correlation_id: "web-01/AbC-7",
        authorization: "Bearer abc.def.ghi",
      },
      before: { subject: "Spring sale", status: "draft" },
      after: { subject: "Spring SALE", status: "draft" },
    },
  };

  function mountDialog(
    props: Partial<Parameters<typeof AuditDetailDialog>[0]> = {},
  ): Root {
    return render(
      createElement(AuditDetailDialog, {
        row: ROW,
        returnFocus: { current: null },
        onClose: () => {},
        onOpenChain: () => {},
        ...props,
      }),
    ).root;
  }

  it("Parsed lists only the fields that moved; JSON is the redacted payload; Copy JSON copies exactly that", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const root = mountDialog();
    try {
      await waitFor(() => {
        expect(bodyText()).toContain("What changed");
      });
      const parsed =
        document.querySelector('dl[aria-label="Before/after diff"]')
          ?.textContent ?? "";
      expect(parsed).toContain("subject");
      expect(parsed).toContain("Spring sale");
      expect(parsed).toContain("Spring SALE");
      // `status` was identical in before/after: not a change, not listed.
      expect(parsed).not.toContain("status");
      // The JSON pane is not mounted until asked for.
      expect(document.querySelector("pre")).toBeNull();

      await click(
        Array.from(
          document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
        ).find((tab) => tab.textContent === "JSON"),
      );
      await waitFor(() => {
        expect(document.querySelector("pre")).not.toBeNull();
      });
      const json = document.querySelector("pre")?.textContent ?? "";
      expect(json).toContain('"[redacted]"');
      expect(json).not.toContain("abc.def.ghi");

      await click(buttonsByText("Copy JSON")[0]);
      expect(writeText).toHaveBeenCalledTimes(1);
      const copied = String(writeText.mock.calls[0]?.[0]);
      // Exactly the redacted text the pane shows — never the raw row.
      expect(copied).toBe(
        JSON.stringify(redactAuditMetadata(ROW.metadata), null, 2),
      );
      expect(copied).not.toContain("abc.def.ghi");
      await waitFor(() => {
        expect(buttonsByText("Copied")).toHaveLength(1);
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("parses a payload without a before/after pair as fields rather than dumping it", async () => {
    const root = mountDialog({
      row: { ...ROW, metadata: { deleted: 12, reason: "retention" } },
    });
    try {
      await waitFor(() => {
        expect(bodyText()).toContain("What changed");
      });
      const fields =
        document.querySelector('dl[aria-label="Payload fields"]')
          ?.textContent ?? "";
      expect(fields).toContain("deleted");
      expect(fields).toContain("12");
      expect(fields).toContain("reason");
      expect(fields).toContain("retention");
    } finally {
      act(() => root.unmount());
    }
  });

  it("offers Filter to this resource only when the opener owns filter state", async () => {
    const onFilterResource = vi.fn();
    const root = mountDialog({ onFilterResource });
    try {
      await waitFor(() => {
        expect(buttonsByText("Filter to this resource")).toHaveLength(1);
      });
      await click(buttonsByText("Filter to this resource")[0]);
      expect(onFilterResource).toHaveBeenCalledWith(ROW);
    } finally {
      act(() => root.unmount());
    }
    const bare = mountDialog();
    try {
      await waitFor(() => {
        expect(bodyText()).toContain("What changed");
      });
      expect(buttonsByText("Filter to this resource")).toHaveLength(0);
    } finally {
      act(() => bare.unmount());
    }
  });
});
