// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// ECO-22: the chain dialog reads one request's audit rows as a narrative —
// what changed, by whom, when — and the audit log row offers the way in.
//
// Before this, GET /api/v1/audit/chain/{requestId} had been mounted and
// correlation-stamped for every audit row, and a grep for "audit/chain" across
// every client returned nothing: the operator still joined ids by hand.

import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuditChain: vi.fn(),
  listAuditLog: vi.fn(),
  countAuditLog: vi.fn(),
  whoami: vi.fn(),
  getAuditCapabilities: vi.fn(),
  listAuditAccessRequests: vi.fn(),
  listAuditSavedViews: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@/lib/audit-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit-api")>();
  return {
    ...actual, // keep correlationIdOf + auditExportPath real
    getAuditChain: mocks.getAuditChain,
    listAuditLog: mocks.listAuditLog,
    countAuditLog: mocks.countAuditLog,
  };
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
  useSearchParams: () => new URLSearchParams(),
}));

import AuditLogPage from "@/app/(dashboard)/app/settings/audit/page";
import {
  AuditChainDialog,
  summarizeChange,
} from "@/components/settings/audit-chain-dialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: ReactNode): Root {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
  return root;
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

const CHAIN_ROWS = [
  {
    id: 101,
    action: "campaign.updated",
    resourceType: "campaign",
    resourceId: "5f0d2ac4-1111-4b2c-9d3e-000000000001",
    actorType: "user",
    actorLabel: "ada@example.com",
    at: "2026-08-04T10:00:00.000Z",
    metadata: {
      context: { correlation_id: "web-01/AbC-7" },
      before: { subject: "Spring sale", status: "draft" },
      after: { subject: "Spring SALE", status: "draft" },
    },
  },
  {
    id: 102,
    action: "approval.decided",
    resourceType: "approval",
    actorType: "user",
    actorLabel: "grace@example.com",
    at: "2026-08-04T10:00:00.120Z",
    metadata: {
      context: { correlation_id: "web-01/AbC-7" },
      after: { decision: "approved" },
    },
  },
  {
    id: 103,
    action: "campaign.queued",
    resourceType: "campaign",
    actorType: "system",
    at: "2026-08-04T10:00:01.500Z",
    metadata: { context: { correlation_id: "web-01/AbC-7" } },
  },
];

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

beforeEach(() => {
  mocks.listAuditAccessRequests.mockResolvedValue([]);
  mocks.listAuditSavedViews.mockResolvedValue([]);
  // The feed's companion total; left unmocked it would reach for the network.
  mocks.countAuditLog.mockResolvedValue({ totalEstimate: 2, confidence: "exact" });
  mocks.whoami.mockResolvedValue({
    id: "11111111-1111-7111-8111-111111111111",
    email: "admin@example.test",
    tenant_id: "22222222-2222-4222-8222-222222222222",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
  });
  mocks.getAuditCapabilities.mockResolvedValue({
    scopes: ["audit:read", "audit:read_pii", "audit:execute_actions"],
    auditScopes: ["audit:read", "audit:read_pii", "audit:execute_actions"],
    isAdmin: true,
  });
});

describe("summarizeChange", () => {
  it("reports only the fields whose value actually moved", () => {
    const summary = summarizeChange({
      before: { subject: "a", status: "draft" },
      after: { subject: "b", status: "draft" },
    });
    expect(summary.kind).toBe("updated");
    expect(summary.fields.map((f) => f.name)).toEqual(["subject"]);
  });

  it("calls an after-only payload a creation and a before-only one a removal", () => {
    expect(summarizeChange({ after: { decision: "approved" } }).kind).toBe(
      "created",
    );
    expect(summarizeChange({ before: { decision: "approved" } }).kind).toBe(
      "removed",
    );
  });

  it("treats request context alone as no change — it is how the row got here", () => {
    const summary = summarizeChange({ context: { correlation_id: "r" } });
    expect(summary.kind).toBe("none");
    expect(summary.fields).toEqual([]);
  });

  it("presents a scalar payload whole rather than inventing field names", () => {
    const summary = summarizeChange({ before: "draft", after: "sending" });
    expect(summary.fields).toEqual([
      { name: "value", before: "draft", after: "sending" },
    ]);
  });
});

describe("AuditChainDialog", () => {
  it("reads one request as a narrative: what changed, by whom, when", async () => {
    mocks.getAuditChain.mockResolvedValue({
      requestId: "web-01/AbC-7",
      rows: CHAIN_ROWS,
      truncated: false,
    });
    const root = render(
      createElement(AuditChainDialog, {
        requestId: "web-01/AbC-7",
        onClose: () => {},
      }),
    );
    try {
      await waitFor(() => {
        expect(bodyText()).toContain("campaign.updated");
      });
      expect(mocks.getAuditChain).toHaveBeenCalledWith("web-01/AbC-7");

      const text = bodyText();
      // What changed — the field, its old value and its new one. Scoped to the
      // change list, not the body: the raw-payload disclosure below it holds
      // the whole metadata blob and would match anything.
      const changes = document.querySelector("ol > li dl")?.textContent ?? "";
      expect(changes).toContain("subject");
      expect(changes).toContain("Spring sale");
      expect(changes).toContain("Spring SALE");
      // ...and only the field that moved: `status` was identical in before/after.
      expect(changes).not.toContain("status");
      // By whom.
      expect(text).toContain("ada@example.com");
      expect(text).toContain("grace@example.com");
      // When, relative to the start of the request — absolute clock times
      // inside one request are all the same second, which is why joining these
      // rows by timestamp failed in the first place.
      expect(text).toContain("+0ms");
      expect(text).toContain("+120ms");
      expect(text).toContain("+1.50s");
      // Three entries, one screen.
      expect(text).toContain("3 entries, in the order they happened");

      // Causal order: the mutation, then the approval, then the dispatch.
      const items = Array.from(document.querySelectorAll("ol > li"));
      expect(items).toHaveLength(3);
      expect(items[0]?.textContent).toContain("campaign.updated");
      expect(items[1]?.textContent).toContain("approval.decided");
      expect(items[2]?.textContent).toContain("campaign.queued");
    } finally {
      act(() => root.unmount());
    }
  });

  it("says nothing was audited under the request — it does not call that an error", async () => {
    // The server answers an unknown request id with 200 and an empty chain.
    // "Not found" would imply the request never happened, a different claim.
    mocks.getAuditChain.mockResolvedValue({
      requestId: "req-nothing",
      rows: [],
      truncated: false,
    });
    const root = render(
      createElement(AuditChainDialog, {
        requestId: "req-nothing",
        onClose: () => {},
      }),
    );
    try {
      await waitFor(() => {
        expect(bodyText()).toContain("Nothing was audited under this request");
      });
      const text = bodyText();
      expect(text).not.toContain("Could not load");
      expect(text).not.toContain("Try again");
      expect(document.querySelectorAll("ol > li")).toHaveLength(0);
    } finally {
      act(() => root.unmount());
    }
  });

  it("says the chain was cut off when the server hit its cap", async () => {
    mocks.getAuditChain.mockResolvedValue({
      requestId: "web-01/AbC-7",
      rows: CHAIN_ROWS,
      truncated: true,
    });
    const root = render(
      createElement(AuditChainDialog, {
        requestId: "web-01/AbC-7",
        onClose: () => {},
      }),
    );
    try {
      await waitFor(() => {
        expect(bodyText()).toContain("500-entry cap");
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows the server's own message when the read is refused", async () => {
    mocks.getAuditChain.mockRejectedValue(
      new Error("Your role does not permit reading the audit log."),
    );
    const root = render(
      createElement(AuditChainDialog, {
        requestId: "web-01/AbC-7",
        onClose: () => {},
      }),
    );
    try {
      await waitFor(() => {
        expect(bodyText()).toContain(
          "Your role does not permit reading the audit log.",
        );
      });
      // A refusal is not an empty chain.
      expect(bodyText()).not.toContain("Nothing was audited");
    } finally {
      act(() => root.unmount());
    }
  });

  it("fetches nothing while closed", async () => {
    const root = render(
      createElement(AuditChainDialog, { requestId: null, onClose: () => {} }),
    );
    try {
      await act(async () => {
        await flush();
      });
      expect(mocks.getAuditChain).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("audit log row → chain", () => {
  const FEED_ROWS = [
    {
      id: 101,
      action: "campaign.updated",
      resourceType: "campaign",
      resourceId: "5f0d2ac4-1111-4b2c-9d3e-000000000001",
      actorType: "user",
      actorLabel: "ada@example.com",
      ip: "203.0.113.7",
      metadata: { context: { correlation_id: "web-01/AbC-7" } },
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

  it("offers the chain only on the row that carries a request id, and opens it", async () => {
    mocks.listAuditLog.mockResolvedValue({ rows: FEED_ROWS });
    mocks.getAuditChain.mockResolvedValue({
      requestId: "web-01/AbC-7",
      rows: CHAIN_ROWS,
      truncated: false,
    });
    const root = render(createElement(AuditLogPage));
    try {
      await waitFor(() => {
        expect(bodyText()).toContain("retention.pruned");
      });
      // Two viewports render the feed (stacked cards + table), so one row with
      // a correlation id yields two "Chain" buttons and the worker row yields
      // none — a "Chain" per row would be 4.
      const chainButtons = buttonsByText("Chain");
      expect(chainButtons).toHaveLength(2);
      expect(buttonsByText("View")).toHaveLength(4);

      act(() => {
        chainButtons[0]?.click();
      });
      await waitFor(() => {
        expect(bodyText()).toContain("approval.decided");
      });
      expect(mocks.getAuditChain).toHaveBeenCalledWith("web-01/AbC-7");
    } finally {
      act(() => root.unmount());
    }
  });

  it("opens one readable entry detail, contains long evidence, and restores row focus", async () => {
    mocks.listAuditLog.mockResolvedValue({
      rows: [
        {
          ...FEED_ROWS[0],
          userAgent: `Browser/${"very-long-token-".repeat(20)}`,
          metadata: {
            context: { correlation_id: "web-01/AbC-7" },
            after: { note: "unbroken-evidence-".repeat(30) },
          },
        },
      ],
    });
    const root = render(createElement(AuditLogPage));
    try {
      await waitFor(() => {
        expect(bodyText()).toContain("campaign.updated");
      });
      const trigger = document.querySelector<HTMLButtonElement>(
        'button[aria-label="View audit entry campaign.updated"]',
      );
      expect(trigger).not.toBeNull();
      act(() => trigger?.click());

      // The detail dialog is intentionally outside the audit feed's initial
      // bundle. Wait for the real deferred module to mount before asserting
      // its behavior instead of mistaking the loading boundary for the dialog.
      await waitFor(() => {
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      });
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog?.textContent).toContain("ada@example.com");
      expect(dialog?.textContent).toContain("What changed");
      // The Parsed view (default) carries the evidence, contained by break-all.
      expect(dialog?.textContent).toContain("unbroken-evidence");
      expect(
        dialog?.querySelector('dl[aria-label="Before/after diff"] dd')
          ?.className,
      ).toContain("break-all");
      // The verbatim JSON sits behind its tab and wraps rather than overflows.
      const jsonTab = Array.from(
        dialog?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
      ).find((tab) => tab.textContent === "JSON");
      expect(jsonTab).not.toBeNull();
      await act(async () => {
        jsonTab?.click();
        await flush();
      });
      expect(dialog?.querySelector("pre")?.className).toContain(
        "whitespace-pre-wrap",
      );
      const copyResourceId = dialog?.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy to clipboard"]',
      );
      expect(copyResourceId).not.toBeNull();
      expect(copyResourceId?.className).toContain("min-w-11");
      expect(dialog?.contains(document.activeElement)).toBe(true);

      const closeButtons = Array.from(
        dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      ).filter((button) => button.textContent?.trim() === "Close");
      act(() => closeButtons.at(-1)?.click());
      await waitFor(() => {
        expect(document.querySelector('[role="dialog"]')).toBeNull();
      });
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    } finally {
      act(() => root.unmount());
    }
  });
});
