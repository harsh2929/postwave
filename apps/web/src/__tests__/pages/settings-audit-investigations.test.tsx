// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// governance-34..37 on web. Before this, every literal — `investigations/`,
// `/stream`, `audit/events?ids`, `/approve`, `/reject` — was absent from
// apps/web/src: the agent's investigations could be reviewed on desktop only.
//
// Each test asserts the consequence of a verb at the transport: the GET/POST
// path and body that leave `@/lib/api`, the EventSource URL, the sentence
// the person is shown. The confirm copy and the reason rule are asserted
// because they ARE the product decision (approval applies nothing;
// rejection is recorded with a visible reason).

import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitFor } from "./_wait";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  mintStreamToken: vi.fn(),
  whoami: vi.fn(),
  getAuditCapabilities: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  params: { id: "inv-1" } as { id?: string },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: mocks.apiGet, post: mocks.apiPost },
  };
});

vi.mock("@/lib/alerting-access-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/alerting-access-api")>()),
  mintStreamToken: mocks.mintStreamToken,
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/audit-saved-views-access-api", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/audit-saved-views-access-api")
  >()),
  getAuditCapabilities: mocks.getAuditCapabilities,
}));

vi.mock("@/components/settings/audit-views-access-panels", () => ({
  AuditRestrictedAccessPanel: () =>
    createElement("div", { "data-testid": "restricted-panel" }, "Restricted"),
}));

vi.mock("next/navigation", () => ({
  useParams: () => mocks.params,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/app/settings/audit/investigations",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import AuditInvestigationDetailPage from "@/app/(dashboard)/app/settings/audit/investigations/[id]/page";
import { ADMIN_REQUIRED_TO_DECIDE } from "@/app/(dashboard)/app/settings/audit/investigations/_components/investigation-decision";
import AuditInvestigationsPage from "@/app/(dashboard)/app/settings/audit/investigations/page";
import { ApiError } from "@/lib/api";
import {
  REJECTION_REASON_REQUIRED,
  type AuditInvestigation,
} from "@/lib/audit-investigations-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Enough of EventSource to open, deliver named frames, and fail. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 0;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(
    public readonly url: string,
    public readonly init?: { withCredentials?: boolean },
  ) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event("open"));
  }

  emit(type: string, data: unknown): void {
    const event = Object.assign(new Event(type), {
      data: JSON.stringify(data),
    });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }
}

const TENANT = "22222222-2222-4222-8222-222222222222";

function identity(role: "admin" | "editor" = "admin") {
  return {
    user_id: "11111111-1111-7111-8111-111111111111",
    email: "ops@example.test",
    tenant_id: TENANT,
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  };
}

function capabilities(patch: {
  isAdmin?: boolean;
  auditScopes?: string[];
} = {}) {
  const auditScopes = patch.auditScopes ?? ["audit:read", "audit:read_pii"];
  return {
    scopes: [...auditScopes, "reports:read"],
    auditScopes,
    isAdmin: patch.isAdmin ?? true,
  };
}

function row(id: number, action: string, at: string) {
  return {
    id,
    action,
    resourceType: "user",
    resourceId: "user-mallory",
    actorType: "human",
    actorLabel: "mallory@example.test",
    ip: "203.0.113.7",
    metadata: {},
    at,
  };
}

const ROWS: Record<number, ReturnType<typeof row>> = {
  40: row(40, "auth.login.failed", "2026-09-01T09:58:00.000Z"),
  41: row(41, "auth.login.failed", "2026-09-01T09:59:00.000Z"),
  42: row(42, "auth.login", "2026-09-01T10:00:00.000Z"),
};

function draft(patch: Partial<AuditInvestigation> = {}): AuditInvestigation {
  return {
    id: "inv-1",
    tenant_id: TENANT,
    seed_audit_id: 42,
    findings: [
      {
        num: 1,
        hypothesis: "Credential stuffing from a new ASN",
        mitre_techniques: ["T1110.004"],
        confidence: 0.82,
        evidence_audit_ids: [41, 42],
        detector_reasons: ["burst_login_failures"],
      },
    ],
    evidence_audit_ids: [40, 41, 42],
    proposed_actions: [
      {
        id: "act-1",
        action: "force_reauth",
        target_id: "user-mallory",
        rationale: "Sessions minted during the burst.",
        severity: "high",
        requires_human_approval: true,
        evidence_audit_ids: [42],
      },
    ],
    mitre_techniques: ["T1110.004"],
    confidence: 0.82,
    status: "draft",
    created_at: "2026-09-01T10:00:30.000Z",
    updated_at: "2026-09-01T10:00:30.000Z",
    ...patch,
  };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function idsOf(path: string): number[] {
  const raw = new URL(path, "http://localhost").searchParams.get("ids") ?? "";
  return raw ? raw.split(",").map(Number) : [];
}

/**
 * Routes GETs by path. `detail` is read per call so a test can flip the
 * persisted status between reads, the way a stream frame would.
 */
function routeGets(options: {
  list?: AuditInvestigation[] | Error;
  detail?: () => AuditInvestigation | Error;
  events?: (ids: number[]) => ReturnType<typeof row>[] | Error;
}): void {
  mocks.apiGet.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/v1/audit/investigations?")) {
      const list = options.list ?? [];
      if (list instanceof Error) throw list;
      return { investigations: list };
    }
    if (path.startsWith("/api/v1/audit/investigations/")) {
      const detail = (options.detail ?? draft)();
      if (detail instanceof Error) throw detail;
      return detail;
    }
    if (path.startsWith("/api/v1/audit/events?")) {
      const ids = idsOf(path);
      const items = options.events
        ? options.events(ids)
        : ids.map((id) => ROWS[id]).filter(Boolean);
      if (items instanceof Error) throw items;
      return { items };
    }
    throw new Error(`unexpected GET ${path}`);
  });
}

function getCalls(prefix: string): string[] {
  return mocks.apiGet.mock.calls
    .map(([path]) => path as string)
    .filter((path) => path.startsWith(prefix));
}

const roots: Root[] = [];

function render(ui: ReactNode): Root {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
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

function buttonsByText(text: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button")).filter(
    (b): b is HTMLButtonElement =>
      b instanceof HTMLButtonElement && b.textContent?.trim() === text,
  );
}

function button(text: string): HTMLButtonElement {
  const matches = buttonsByText(text);
  expect(matches, `button "${text}"`).toHaveLength(1);
  return matches[0]!;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
  });
}

/** Controlled React inputs only see a value change through the native setter. */
async function typeInto(
  element: HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}

/** Body text with runs of whitespace collapsed, so JSX line breaks don't hide a match. */
function bodyText(): string {
  return (document.body.textContent ?? "").replace(/\s+/g, " ");
}

function textarea(): HTMLTextAreaElement {
  const el = document.querySelector("textarea");
  expect(el).toBeInstanceOf(HTMLTextAreaElement);
  return el as HTMLTextAreaElement;
}

async function openStream(): Promise<FakeEventSource> {
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  return FakeEventSource.instances[0]!;
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  FakeEventSource.instances = [];
  mocks.params = { id: "inv-1" };
  mocks.whoami.mockResolvedValue(identity());
  mocks.getAuditCapabilities.mockResolvedValue(capabilities());
  mocks.mintStreamToken.mockResolvedValue({
    token: "pws_test",
    expiresAt: "2026-09-01T10:01:00.000Z",
    ttlSeconds: 30,
  });
  routeGets({ list: [draft()] });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("investigations list (governance-34)", () => {
  it("lists from the mounted route with the 50-row limit and links each row to its review page", async () => {
    render(createElement(AuditInvestigationsPage));
    await waitFor(() => expect(bodyText()).toContain("#42"));

    expect(getCalls("/api/v1/audit/investigations")).toEqual([
      "/api/v1/audit/investigations?limit=50",
    ]);
    const open = document.querySelector(
      'a[href="/app/settings/audit/investigations/inv-1"]',
    );
    expect(open?.textContent?.trim()).toBe("Open");
    expect(
      document.querySelector('[data-status="draft"]')?.textContent,
    ).toBe("Draft");
  });

  it("renders the server's refusal verbatim, as a failure not an empty list, and retries the same request", async () => {
    routeGets({
      list: new ApiError(
        "investigation agent not configured",
        503,
        {
          error: {
            code: "agent_unavailable",
            message: "investigation agent not configured",
          },
        },
        { code: "agent_unavailable" },
      ),
    });
    render(createElement(AuditInvestigationsPage));
    await waitFor(() =>
      expect(bodyText()).toContain("investigation agent not configured"),
    );
    expect(bodyText()).toContain("This is a failed request, not an empty list");
    expect(bodyText()).not.toContain("No investigations yet");

    await click(button("Retry"));
    await waitFor(() =>
      expect(getCalls("/api/v1/audit/investigations?")).toEqual([
        "/api/v1/audit/investigations?limit=50",
        "/api/v1/audit/investigations?limit=50",
      ]),
    );
  });

  it("withholds the list from a caller without raw audit access", async () => {
    mocks.getAuditCapabilities.mockResolvedValue(
      capabilities({ auditScopes: ["audit:read"] }),
    );
    render(createElement(AuditInvestigationsPage));
    await waitFor(() =>
      expect(document.querySelector('[data-testid="restricted-panel"]')).not
        .toBeNull(),
    );
    expect(getCalls("/api/v1/audit/investigations")).toEqual([]);
  });
});

describe("investigation detail (governance-35)", () => {
  it("reads the investigation, batches every cited row through /audit/events in ≤100-id chunks, and opens the token-carrying stream", async () => {
    const ids = range(1, 150);
    routeGets({
      detail: () => draft({ evidence_audit_ids: ids }),
      events: (wanted) =>
        wanted
          .filter((id) => id === 42 || id === 150)
          .map((id) => ROWS[id] ?? row(id, "auth.login.failed", "2026-09-01T09:00:00.000Z")),
    });
    render(createElement(AuditInvestigationDetailPage));
    await waitFor(() =>
      expect(bodyText()).toContain("Investigation · seed #42"),
    );

    expect(getCalls("/api/v1/audit/investigations/")).toEqual([
      "/api/v1/audit/investigations/inv-1",
    ]);
    await waitFor(() =>
      expect(getCalls("/api/v1/audit/events?")).toHaveLength(2),
    );
    expect(getCalls("/api/v1/audit/events?").map(idsOf)).toEqual([
      range(1, 100),
      range(101, 150),
    ]);

    const stream = await openStream();
    expect(stream.url).toBe(
      "/api/v1/audit/investigations/inv-1/stream?stream_token=pws_test",
    );
    expect(stream.init?.withCredentials).toBe(true);

    // Timeline: oldest first, the seed row marked.
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="investigation-timeline"] li'),
      ).toHaveLength(2),
    );
    const items = Array.from(
      document.querySelectorAll('[data-testid="investigation-timeline"] li'),
    ).map((li) => li.textContent ?? "");
    expect(items[0]).toContain("auth.login.failed");
    expect(items[1]).toContain("auth.login");
    expect(items[1]).toContain("seed");
    expect(bodyText()).toContain(
      "148 of 150 evidence rows are no longer in the audit log",
    );
  });

  it("re-reads the investigation when the stream announces a status change, and logs the frame", async () => {
    let status: AuditInvestigation["status"] = "draft";
    routeGets({ detail: () => draft({ status }) });
    render(createElement(AuditInvestigationDetailPage));
    const stream = await openStream();
    await act(async () => {
      stream.open();
      await flush();
    });
    expect(bodyText()).toContain("Live — status changes appear");

    status = "approved";
    await act(async () => {
      stream.emit("status", {
        type: "status",
        status: "approved",
        message: "Remediation plan approved for manual or external execution.",
        ts: "2026-09-01T10:05:00.000Z",
      });
      await flush();
    });
    await waitFor(() =>
      expect(getCalls("/api/v1/audit/investigations/")).toHaveLength(2),
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-status="approved"]')?.textContent,
      ).toBe("Approved"),
    );
    expect(
      document.querySelector('[data-testid="investigation-stream-log"]')
        ?.textContent,
    ).toContain(
      "[2026-09-01T10:05:00.000Z] status: Remediation plan approved for manual or external execution.",
    );
  });

  it("falls back to polling when the stream errors, and says so", async () => {
    render(createElement(AuditInvestigationDetailPage));
    const stream = await openStream();
    await act(async () => {
      stream.fail();
      await flush();
    });
    await waitFor(() =>
      expect(bodyText()).toContain(
        "Live updates unavailable — re-checking every 15s",
      ),
    );
    expect(stream.closed).toBe(true);
    expect(
      document.querySelector('[data-stream-mode="polling"]'),
    ).not.toBeNull();
  });

  it("retries only the evidence chunk that failed", async () => {
    let secondChunkFailures = 1;
    routeGets({
      detail: () => draft({ evidence_audit_ids: range(1, 150) }),
      events: (ids) => {
        if (ids[0] === 101 && secondChunkFailures > 0) {
          secondChunkFailures -= 1;
          return new Error("audit store timed out");
        }
        return ids.filter((id) => id === 42).map((id) => ROWS[id]!);
      },
    });
    render(createElement(AuditInvestigationDetailPage));
    await waitFor(() =>
      expect(bodyText()).toContain("Couldn't load 50 of 150 evidence rows"),
    );
    expect(bodyText()).toContain("audit store timed out");

    await click(button("Retry"));
    await waitFor(() =>
      expect(getCalls("/api/v1/audit/events?").map(idsOf)).toEqual([
        range(1, 100),
        range(101, 150),
        range(101, 150),
      ]),
    );
    await waitFor(() =>
      expect(bodyText()).not.toContain("Couldn't load 50 of 150"),
    );
  });
});

describe("approve (governance-36)", () => {
  it("confirms with the consequence, then posts the whole-plan approval to the admin route and re-reads", async () => {
    mocks.apiPost.mockResolvedValue({
      id: "inv-1",
      status: "approved",
      execution_state: "not_executed",
      message:
        "Remediation plan approved for manual or external execution; Moosewave did not apply account changes.",
    });
    render(createElement(AuditInvestigationDetailPage));
    await waitFor(() => button("Approve remediation plan"));

    await click(button("Approve remediation plan"));
    await waitFor(() =>
      expect(bodyText()).toContain("Approve the remediation plan?"),
    );
    expect(bodyText()).toContain(
      "Moosewave will not apply the identity, key, token, MFA, or IP changes itself",
    );
    expect(mocks.apiPost).not.toHaveBeenCalled();

    await click(button("Approve plan"));
    await waitFor(() =>
      expect(mocks.apiPost).toHaveBeenCalledWith(
        "/api/v1/audit/investigations/inv-1/approve",
        { notes: "" },
        expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
      ),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Remediation plan approved for manual or external execution; Moosewave did not apply account changes.",
    );
    await waitFor(() =>
      expect(getCalls("/api/v1/audit/investigations/")).toHaveLength(2),
    );
  });

  it("renders the server's refusal inside the confirm when approval is rejected", async () => {
    mocks.apiPost.mockRejectedValue(
      new ApiError(
        "investigation could not be approved in its current state",
        409,
        {
          error: {
            code: "approve_failed",
            message: "investigation could not be approved in its current state",
          },
        },
        { code: "approve_failed" },
      ),
    );
    render(createElement(AuditInvestigationDetailPage));
    await waitFor(() => button("Approve remediation plan"));
    await click(button("Approve remediation plan"));
    await waitFor(() => button("Approve plan"));
    await click(button("Approve plan"));
    await waitFor(() =>
      expect(
        document.querySelector('[role="alert"]')?.textContent,
      ).toContain("investigation could not be approved in its current state"),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("withholds approve and reject from a non-admin, with the reason", async () => {
    mocks.whoami.mockResolvedValue(identity("editor"));
    mocks.getAuditCapabilities.mockResolvedValue(
      capabilities({ isAdmin: false }),
    );
    render(createElement(AuditInvestigationDetailPage));
    await waitFor(() => expect(bodyText()).toContain(ADMIN_REQUIRED_TO_DECIDE));
    expect(buttonsByText("Approve remediation plan")).toHaveLength(0);
    expect(buttonsByText("Reject")).toHaveLength(0);
  });

  it("withholds approve and reject once the plan is no longer a draft, and shows the recorded reason", async () => {
    routeGets({
      detail: () =>
        draft({
          status: "rejected",
          rejection_reason: "confirmed false positive — own device",
        }),
    });
    render(createElement(AuditInvestigationDetailPage));
    await waitFor(() =>
      expect(bodyText()).toContain("confirmed false positive — own device"),
    );
    expect(bodyText()).toContain("This investigation was rejected");
    expect(buttonsByText("Approve remediation plan")).toHaveLength(0);
    expect(buttonsByText("Reject")).toHaveLength(0);
  });
});

describe("reject (governance-37)", () => {
  it("requires a reason before any request leaves, then posts it to the admin route", async () => {
    mocks.apiPost.mockResolvedValue({ id: "inv-1", status: "rejected" });
    render(createElement(AuditInvestigationDetailPage));
    await waitFor(() => button("Reject"));

    await click(button("Reject"));
    await waitFor(() => button("Reject investigation"));
    expect(bodyText()).toContain("visible to anyone with audit:read");

    await click(button("Reject investigation"));
    await waitFor(() =>
      expect(
        document.querySelector('[role="alert"]')?.textContent,
      ).toBe(REJECTION_REASON_REQUIRED),
    );
    expect(mocks.apiPost).not.toHaveBeenCalled();

    await typeInto(textarea(), "  confirmed false positive  ");
    await click(button("Reject investigation"));
    await waitFor(() =>
      expect(mocks.apiPost).toHaveBeenCalledWith(
        "/api/v1/audit/investigations/inv-1/reject",
        { reason: "confirmed false positive" },
        expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
      ),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Investigation rejected.");
    await waitFor(() =>
      expect(buttonsByText("Reject investigation")).toHaveLength(0),
    );
  });

  it("guards a typed reason behind a discard confirmation", async () => {
    render(createElement(AuditInvestigationDetailPage));
    await waitFor(() => button("Reject"));
    await click(button("Reject"));
    await waitFor(() => button("Reject investigation"));
    await typeInto(textarea(), "half-written reason");

    await click(button("Cancel"));
    await waitFor(() =>
      expect(bodyText()).toContain("Discard rejection reason?"),
    );

    await click(button("Keep editing"));
    await waitFor(() =>
      expect(bodyText()).not.toContain("Discard rejection reason?"),
    );
    expect(textarea().value).toBe("half-written reason");

    await click(button("Cancel"));
    await waitFor(() => button("Discard reason"));
    await click(button("Discard reason"));
    await waitFor(() =>
      expect(buttonsByText("Reject investigation")).toHaveLength(0),
    );
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });
});
