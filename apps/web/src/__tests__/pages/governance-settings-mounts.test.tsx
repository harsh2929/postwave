// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Reachability for the governance/settings parity components mounted into
// the pages users actually open (parity mount pass, 2026-09-12). Each block
// renders the REAL page (or the page's own section/card module) over one
// stubbed transport and asserts the mounted component both renders there and
// issues its request through the page — not merely that the component works
// in isolation, which its own unit test already proves.
//
//   platform-33       settings/custom-fields  -> CustomFieldLimitsCard
//   governance-92..95 consent-ledger          -> ConsentEvidenceRegister
//                     consent-evidence        -> ConsentOlderEventPages
//   governance-86/87  settings/security SCIM  -> ScimTokenReveal, ScimTokenPrefixCopy
//   governance-72/75  approvals               -> ApprovalsSearchSortBar, ApprovalsAutoRefresh
//   governance-76     approvals/[id]          -> AgentOriginEvidencePanel
//   deliverability-3  settings/domain         -> DomainFilterBar
//   deliverability-17 settings/sender limits  -> ClearSendingLimitsButton
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOnlineStatusForTest } from "@/lib/online-manager";

import { renderPage, unmount, WHOAMI } from "./_harness";
import { importBeforeTests, waitFor } from "./_wait";

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

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

// Fresh-authority re-reads are their own module's concern; here they simply
// confirm the principal the page opened with.
vi.mock("@/lib/admin-mutation-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-mutation-authority")>()),
  verifyFreshAdminAuthority: vi.fn(async (opened: unknown) => opened),
}));

const TENANT = WHOAMI.tenant_id;

interface Call {
  method: string;
  path: string;
  url: string;
  body: unknown;
}

type Route = (call: Call) => { status?: number; body?: unknown } | undefined;

let calls: Call[] = [];

function stubRoutes(route: Route): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const parsed = new URL(raw, "http://postwave.test");
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      let body: unknown = undefined;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      const call: Call = {
        method,
        path: parsed.pathname,
        url: `${parsed.pathname}${parsed.search}`,
        body,
      };
      calls.push(call);
      const answer = route(call);
      if (!answer) {
        return new Response(
          JSON.stringify({ error: { code: "not_found", message: "" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      const status = answer.status ?? 200;
      if (status === 204) return new Response(null, { status });
      return new Response(JSON.stringify(answer.body ?? {}), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function requested(method: string, url: string): boolean {
  return calls.some((call) => call.method === method && call.url === url);
}

async function settle(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function buttonByText(
  container: ParentNode,
  text: string,
): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === text,
  );
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle(4);
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  setOnlineStatusForTest("online");
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/* ------------------------------------------------------------------ */

// Each suite imports its page module before its first test: the module graph
// is cold work for vitest's transform pipeline, and no test's 5 s clock
// should include it.
describe("platform-33 — custom-field limits on settings/custom-fields", () => {
  importBeforeTests(() => import("@/app/(dashboard)/app/settings/custom-fields/page"));

  it("renders the limits card on the page and reads the caps through it", async () => {
    stubRoutes((call) =>
      call.method === "GET" && call.path === "/api/v1/settings/custom-fields"
        ? {
            body: {
              max_custom_fields: 100,
              max_searchable_fields: 3,
              used_custom_fields: 91,
              used_searchable_fields: 3,
            },
          }
        : call.method === "GET" && call.path === "/api/v1/custom-fields"
          ? { body: [] }
          : undefined,
    );
    const Page = (
      await import("@/app/(dashboard)/app/settings/custom-fields/page")
    ).default;
    const { container, root } = await renderPage(Page);
    try {
      await waitFor(() => {
        expect(
          container.querySelector('[aria-label="Total fields usage"]'),
        ).not.toBeNull();
      });
      expect(requested("GET", "/api/v1/settings/custom-fields")).toBe(true);
      expect(container.textContent).toContain("Custom-field limits");
      expect(
        container
          .querySelector('[aria-label="Searchable fields usage"]')
          ?.getAttribute("aria-valuetext"),
      ).toBe("3 of 3 fields used · at limit");
      // The owner fixture may configure them from the page itself.
      expect(buttonByText(container, "Configure limits")).toBeTruthy();
    } finally {
      unmount(root);
    }
  });
});

/* ------------------------------------------------------------------ */

const SNAPSHOT = "2026-09-01T10:00:00Z";
const RECEIPT_CURSOR = "eyJyZWNlaXB0cyI6MX0.cmVjZWlwdC1zaWc";
const EVENT_CURSOR = "eyJldmVudHMiOjF9.ZXZlbnQtc2ln";

describe("governance-92..95 — receipt register on consent-ledger", () => {
  importBeforeTests(() => import("@/app/(dashboard)/app/consent-ledger/page"));

  it("replaces the flat list with the searchable register and pages older receipts", async () => {
    const receipt = (over: Record<string, unknown>) => ({
      id: "r-30",
      subscriber_email: "page.one@example.test",
      new_state: "granted",
      source: "preference_centre",
      kind: "receipt",
      at: "2026-08-30T09:00:00Z",
      recorded_at: "2026-08-30T09:00:01Z",
      ...over,
    });
    stubRoutes((call) => {
      if (call.method !== "GET" || call.path !== "/api/v1/consent/receipts") {
        return undefined;
      }
      if (call.url.includes("cursor=")) {
        return {
          body: {
            schema_version: 2,
            workspace_id: TENANT,
            snapshot_at: SNAPSHOT,
            source_planes: ["consent_receipts", "consent_records"],
            count: 1,
            has_more: false,
            receipts: [
              receipt({
                id: "r-10",
                subscriber_email: "older.receipt@example.test",
                at: "2026-08-01T10:00:00Z",
                recorded_at: "2026-08-21T10:00:00Z",
              }),
            ],
          },
        };
      }
      return {
        body: {
          schema_version: 2,
          workspace_id: TENANT,
          snapshot_at: SNAPSHOT,
          source_planes: ["consent_receipts", "consent_records"],
          count: 2,
          has_more: true,
          next_cursor: RECEIPT_CURSOR,
          receipts: [receipt({})],
        },
      };
    });
    const Page = (await import("@/app/(dashboard)/app/consent-ledger/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await waitFor(() => {
        expect(
          container.querySelector(
            'ul[aria-label="Loaded receipt and proof evidence"]',
          ),
        ).not.toBeNull();
      });
      expect(container.textContent).toContain("page.one@example.test");
      expect(container.textContent).toContain("1 of 1 loaded");
      const loadOlder = buttonByText(container, "Load older receipts");
      expect(loadOlder).toBeTruthy();
      await click(loadOlder!);
      await waitFor(() => {
        expect(container.textContent).toContain("older.receipt@example.test");
      });
      expect(
        requested(
          "GET",
          `/api/v1/consent/receipts?cursor=${RECEIPT_CURSOR}&limit=200`,
        ),
      ).toBe(true);
    } finally {
      unmount(root);
    }
  });
});

describe("governance-92..95 — older event pages on consent-evidence", () => {
  importBeforeTests(() => import("@/app/(dashboard)/app/consent-evidence/page"));

  it("appends older consent events under page one by cursor", async () => {
    const event = (over: Record<string, unknown>) => ({
      id: "e-30",
      subject_type: "subscriber",
      subject_id: "s-1",
      subject_email: "page.one.subject@example.test",
      channel: "api",
      category: "email_marketing",
      action: "granted",
      source: "double_optin",
      policy_version: "privacy-2026-01",
      proof_text: "",
      created_at: "2026-08-30T09:00:00Z",
      recorded_at: "2026-08-30T09:00:01Z",
      preferences: {},
      ...over,
    });
    stubRoutes((call) => {
      if (call.method !== "GET" || call.path !== "/api/v1/consent/events") {
        return undefined;
      }
      if (call.url.includes("cursor=")) {
        return {
          body: {
            schema_version: 1,
            workspace_id: TENANT,
            snapshot_at: SNAPSHOT,
            source_planes: ["consent_events"],
            count: 1,
            has_more: false,
            events: [
              event({
                id: "e-10",
                subject_email: "older.subject@example.test",
                created_at: "2026-08-01T10:00:00Z",
                recorded_at: "2026-08-21T10:00:00Z",
              }),
            ],
          },
        };
      }
      return {
        body: {
          schema_version: 1,
          workspace_id: TENANT,
          snapshot_at: SNAPSHOT,
          source_planes: ["consent_events"],
          count: 2,
          has_more: true,
          next_cursor: EVENT_CURSOR,
          events: [event({})],
        },
      };
    });
    const Page = (await import("@/app/(dashboard)/app/consent-evidence/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await waitFor(() => {
        expect(container.textContent).toContain(
          "page.one.subject@example.test",
        );
      });
      const loadOlder = buttonByText(container, "Load older events");
      expect(loadOlder).toBeTruthy();
      await click(loadOlder!);
      await waitFor(() => {
        expect(
          container.querySelector('ul[aria-label="Older consent events"]')
            ?.textContent,
        ).toContain("older.subject@example.test");
      });
      expect(
        requested(
          "GET",
          `/api/v1/consent/events?cursor=${EVENT_CURSOR}&limit=200`,
        ),
      ).toBe(true);
    } finally {
      unmount(root);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("governance-86/87 — SCIM token reveal + prefix copy on settings/security", () => {
  importBeforeTests(() => import("@/app/(dashboard)/app/settings/security/scim-admin-section"));

  const TOKEN_ROW = {
    id: "tok_1",
    prefix: "pst_live",
    description: "Okta production",
    created_at: "2026-06-28T00:00:00.000Z",
    revoked_at: null,
  };

  it("copies a listed token's public prefix from its actions cell", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      onLine: true,
      clipboard: { writeText },
    });
    stubRoutes((call) =>
      call.method === "GET" && call.path === "/api/v1/scim/tokens"
        ? { body: { tokens: [TOKEN_ROW] } }
        : call.method === "GET" && call.path === "/api/v1/scim/role-mappings"
          ? { body: { mappings: [] } }
          : undefined,
    );
    const { ScimAdminSection } =
      await import("@/app/(dashboard)/app/settings/security/scim-admin-section");
    const { container, root } = await renderPage(ScimAdminSection);
    try {
      await waitFor(() => {
        expect(container.textContent).toContain("Okta production");
      });
      expect(requested("GET", "/api/v1/scim/tokens")).toBe(true);
      const copy = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy token prefix pst_live for IdP log searches"]',
      );
      expect(copy).not.toBeNull();
      expect(copy!.disabled).toBe(false);
      await click(copy!);
      expect(writeText).toHaveBeenCalledWith("pst_live");
    } finally {
      unmount(root);
    }
  });

  it("shows a freshly minted token in the masked show-once reveal", async () => {
    let minted = false;
    stubRoutes((call) => {
      if (call.path === "/api/v1/scim/tokens" && call.method === "POST") {
        minted = true;
        return {
          status: 201,
          body: {
            token: "pst_secret_full_token",
            prefix: "pst_new",
            warning: "Shown once",
          },
        };
      }
      if (call.path === "/api/v1/scim/tokens" && call.method === "GET") {
        return {
          body: {
            tokens: minted
              ? [
                  {
                    ...TOKEN_ROW,
                    id: "tok_2",
                    prefix: "pst_new",
                    description: "",
                  },
                ]
              : [],
          },
        };
      }
      if (call.path === "/api/v1/scim/role-mappings") {
        return { body: { mappings: [] } };
      }
      return undefined;
    });
    const { ScimAdminSection } =
      await import("@/app/(dashboard)/app/settings/security/scim-admin-section");
    const { container, root } = await renderPage(ScimAdminSection);
    try {
      await waitFor(() => {
        expect(container.textContent).toContain("No SCIM tokens yet");
      });
      await click(buttonByText(container, "Mint token")!);
      await waitFor(() => {
        expect(
          container.querySelector('section[aria-label="New SCIM token"]'),
        ).not.toBeNull();
      });
      expect(requested("POST", "/api/v1/scim/tokens")).toBe(true);
      const value = container.querySelector('[data-testid="scim-token-value"]');
      expect(value?.textContent).toBe("pst_secret_full_token");
      await click(buttonByText(container, "Hide")!);
      expect(
        container.querySelector('[data-testid="scim-token-value"]')
          ?.textContent,
      ).not.toContain("pst_secret");
      // "Done" stays shut until the operator acknowledges storing it.
      expect(buttonByText(container, "Done — I've saved it")?.disabled).toBe(
        true,
      );
    } finally {
      unmount(root);
    }
  });
});

/* ------------------------------------------------------------------ */

const approval = (over: Record<string, unknown>) => ({
  id: "appr_1",
  tenantId: TENANT,
  resourceType: "campaign",
  resourceId: "cmp_alpha",
  requestedByActorLabel: "Ada",
  status: "pending",
  requestedAt: "2026-06-27T12:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00Z",
  ...over,
});

describe("governance-72/75 — approvals queue search/sort + auto refresh", () => {
  importBeforeTests(() => import("@/app/(dashboard)/app/approvals/page"));

  function approvalsRoute(call: Call) {
    if (call.method === "GET" && call.path === "/api/v1/approvals") {
      return {
        body: {
          approvals: [
            approval({}),
            approval({
              id: "appr_2",
              resourceId: "cmp_bravo",
              requestedByActorLabel: "Grace",
              requestedAt: "2026-06-28T12:00:00.000Z",
            }),
          ],
        },
      };
    }
    return undefined;
  }

  it("narrows the rendered queue through the mounted search bar", async () => {
    stubRoutes(approvalsRoute);
    const Page = (await import("@/app/(dashboard)/app/approvals/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      await waitFor(() => {
        expect(
          container.querySelectorAll('ul[aria-label="Approval queue"] > li'),
        ).toHaveLength(2);
      });
      const form = container.querySelector(
        'form[role="search"][aria-label="Search loaded approvals"]',
      );
      expect(form).not.toBeNull();
      expect(form!.textContent).toContain("Showing 2 of 2 loaded approvals");
      await typeInto(
        container.querySelector<HTMLInputElement>("#approvals-search")!,
        "grace",
      );
      await settle(2);
      const rows = container.querySelectorAll(
        'ul[aria-label="Approval queue"] > li',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.textContent).toContain("cmp_bravo");
      expect(form!.textContent).toContain("Showing 1 of 2 loaded approvals");
    } finally {
      unmount(root);
    }
  });

  it("refetches the queue when the tab regains focus", async () => {
    stubRoutes(approvalsRoute);
    const Page = (await import("@/app/(dashboard)/app/approvals/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      await waitFor(() => {
        expect(container.textContent).toContain(
          "The queue refreshes every minute",
        );
      });
      const before = calls.filter(
        (call) => call.method === "GET" && call.path === "/api/v1/approvals",
      ).length;
      expect(before).toBeGreaterThan(0);
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => {
        expect(
          calls.filter(
            (call) =>
              call.method === "GET" && call.path === "/api/v1/approvals",
          ).length,
        ).toBeGreaterThan(before);
      });
    } finally {
      unmount(root);
    }
  });
});

describe("governance-76 — agent origin evidence on approvals/[id]", () => {
  importBeforeTests(() => import("@/app/(dashboard)/app/approvals/[id]/approval-detail-client"));

  it("reads and renders the linked agent run for an agent-requested approval", async () => {
    stubRoutes((call) => {
      if (call.method === "GET" && call.path === "/api/v1/approvals/appr_1") {
        return {
          body: approval({
            requestedByActorType: "agent",
            requestedByActorLabel: "Winback routine",
          }),
        };
      }
      if (
        call.method === "GET" &&
        call.path === "/api/v1/agent-routines/runs/by-approval/appr_1"
      ) {
        return {
          body: {
            id: "run_1",
            routine_id: "routine_1",
            approval_id: "appr_1",
            status: "completed",
            started_at: "2026-06-27T11:59:00.000Z",
            reasoning: "Lapsed buyers responded to the spring offer.",
          },
        };
      }
      return undefined;
    });
    const { ApprovalDetailClient } =
      await import("@/app/(dashboard)/app/approvals/[id]/approval-detail-client");
    const { container, root } = await renderPage(ApprovalDetailClient, {
      id: "appr_1",
    });
    try {
      await waitFor(() => {
        expect(
          container.querySelector('[data-testid="agent-reasoning"]')
            ?.textContent,
        ).toBe("Lapsed buyers responded to the spring offer.");
      });
      expect(container.textContent).toContain("Origin evidence");
      expect(container.textContent).toContain("Agent run verified");
      expect(
        requested("GET", "/api/v1/agent-routines/runs/by-approval/appr_1"),
      ).toBe(true);
    } finally {
      unmount(root);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("deliverability-3 — domain filter bar on settings/domain", () => {
  importBeforeTests(() => import("@/app/(dashboard)/app/settings/domain/page"));

  it("filters the fetched ownership registry through the mounted bar", async () => {
    const row = (over: Record<string, unknown>) => ({
      id: "dom_1",
      tenantId: TENANT,
      domain: "links.example.test",
      purpose: "links",
      verified: false,
      dns_records: [],
      createdAt: "2026-08-01T10:00:00Z",
      ...over,
    });
    stubRoutes((call) =>
      call.method === "GET" && call.path === "/api/v1/custom-domains"
        ? {
            body: [
              row({}),
              row({
                id: "dom_2",
                domain: "forms.example.test",
                purpose: "forms",
                verified: true,
                dns_records: [
                  {
                    type: "TXT",
                    name: "_postwave.forms.example.test",
                    value: "pw-verify=abc",
                    verified: true,
                  },
                ],
                createdAt: "2026-08-02T10:00:00Z",
                verifiedAt: "2026-08-03T10:00:00Z",
              }),
            ],
          }
        : undefined,
    );
    const Page = (await import("@/app/(dashboard)/app/settings/domain/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await waitFor(() => {
        expect(container.textContent).toContain("links.example.test");
        expect(container.textContent).toContain("forms.example.test");
      });
      expect(requested("GET", "/api/v1/custom-domains")).toBe(true);
      const group = container.querySelector(
        '[role="group"][aria-label="Filter domains by ownership status"]',
      );
      expect(group).not.toBeNull();
      const needsDns = [...group!.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Needs DNS"),
      );
      await click(needsDns!);
      expect(needsDns!.getAttribute("aria-pressed")).toBe("true");
      expect(container.textContent).toContain("links.example.test");
      expect(container.textContent).not.toContain("forms.example.test");
    } finally {
      unmount(root);
    }
  });
});

describe("deliverability-17 — clear limit & quiet hours in the sending-limits card", () => {
  importBeforeTests(() => import("@/app/(dashboard)/app/settings/sender/sending-limits-card"));

  it("offers the confirmed clear and submits the revision-checked reset", async () => {
    stubRoutes((call) =>
      call.method === "PUT" && call.path === "/api/v1/settings/sending"
        ? {
            body: {
              tenant_id: TENANT,
              max_sends_per_hour: null,
              quiet_hours_start: "",
              quiet_hours_end: "",
              quiet_hours_tz: "",
              quiet_hours_per_recipient: true,
              updated_at: "2026-08-30T08:00:00.000000001Z",
            },
          }
        : undefined,
    );
    const Card = (
      await import("@/app/(dashboard)/app/settings/sender/sending-limits-card")
    ).SendingLimitsCard;
    const REVISION = "2026-08-30T08:00:00Z";
    const { container, root } = await renderPage(Card, {
      readiness: null,
      settings: {
        tenant_id: TENANT,
        max_sends_per_hour: 250,
        quiet_hours_start: "22:00",
        quiet_hours_end: "07:00",
        quiet_hours_tz: "UTC",
        quiet_hours_per_recipient: true,
        updated_at: REVISION,
      },
      canWrite: true,
      onSaved: () => undefined,
      identity: WHOAMI,
      authorityKey: `${WHOAMI.tenant_id}:${WHOAMI.user_id}:owner:member`,
      beginSharedMutation: () => true,
      endSharedMutation: () => undefined,
    });
    try {
      const trigger = buttonByText(container, "Clear limit & quiet hours");
      expect(trigger).toBeTruthy();
      expect(trigger!.disabled).toBe(false);
      expect(container.textContent).toContain("Clear scope");
      await click(trigger!);
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog?.textContent).toContain(
        "Clear hourly limit and quiet hours?",
      );
      await click(buttonByText(dialog!, "Clear limit & quiet hours")!);
      await waitFor(() => {
        expect(requested("PUT", "/api/v1/settings/sending")).toBe(true);
      });
      expect(
        calls.find(
          (call) =>
            call.method === "PUT" && call.path === "/api/v1/settings/sending",
        )?.body,
      ).toEqual({
        max_sends_per_hour: null,
        quiet_hours_start: "",
        quiet_hours_end: "",
        quiet_hours_tz: "",
        quiet_hours_per_recipient: true,
        expected_updated_at: REVISION,
      });
    } finally {
      unmount(root);
    }
  });
});
