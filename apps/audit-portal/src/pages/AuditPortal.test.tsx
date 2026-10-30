// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  ApiResult,
  AuditRow,
  Branding,
  ListAuditResponse,
  PortalApiClient,
} from "../lib/portal-api-client";
import { AuditPortal, PORTAL_PAGE_SIZE } from "./AuditPortal";

const branding: Branding = {
  brand_name: "Acme",
  logo_url: "",
  primary_color: "#c8102e",
  support_email: "audit@acme.test",
  tenant_id: "tenant-1",
  scope: "audit:read",
  expires_at: "2030-01-01T00:00:00Z",
};

const row: AuditRow = {
  id: 7,
  action: "user.login",
  actorType: "user",
  actorLabel: "A. Reviewer",
  resourceType: "session",
  resourceId: "session-7",
  ip: "192.0.2.1",
  metadata: {},
  at: "2026-08-13T09:00:00Z",
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

function createApi(overrides: Partial<PortalApiClient>): PortalApiClient {
  return {
    exchangeBootstrap: vi
      .fn<PortalApiClient["exchangeBootstrap"]>()
      .mockResolvedValue({ ok: true, data: null }),
    getBranding: vi
      .fn<PortalApiClient["getBranding"]>()
      .mockResolvedValue({ ok: true, data: branding }),
    listAudit: vi
      .fn<PortalApiClient["listAudit"]>()
      .mockResolvedValue({
        ok: true,
        data: { rows: [], nextCursor: null },
      }),
    downloadAivsBundle: vi
      .fn<PortalApiClient["downloadAivsBundle"]>()
      .mockResolvedValue({
        ok: false,
        status: 503,
        error: "unsafe backend detail",
      }),
    ...overrides,
  };
}

async function renderPortal(
  api: PortalApiClient,
  notifyParent = vi.fn(),
  initialPage?: ApiResult<ListAuditResponse>,
): Promise<{ container: HTMLDivElement; notifyParent: ReturnType<typeof vi.fn> }> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <AuditPortal
        api={api}
        branding={branding}
        notifyParent={notifyParent}
        initialPage={initialPage}
      />,
    );
    await Promise.resolve();
  });
  return { container: host, notifyParent };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === name,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${name}`);
  }
  return match;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AuditPortal release containment", () => {
  it("renders a truthful semantic release hold and removes every evidence affordance", async () => {
    const listAudit = vi.fn(async () => ({
      ok: false as const,
      status: 503,
      error: "database shard alpha leaked an internal release secret",
    }));
    const api = createApi({ listAudit });
    const { container, notifyParent } = await renderPortal(api);

    expect(listAudit).toHaveBeenCalledTimes(1);
    const hold = container.querySelector('[role="status"]');
    expect(hold?.getAttribute("aria-labelledby")).toBe(
      "portal-availability-title",
    );
    expect(container.textContent).toContain("Release hold");
    expect(container.textContent).toContain(
      "Audit evidence is not available in this portal",
    );
    expect(container.textContent).toContain(
      "No event count, completeness state, downloadable proof, or verification result",
    );
    expect(container.textContent).toContain("audit@acme.test");

    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).not.toContain("0 events");
    expect(container.textContent).not.toContain("End of log");
    expect(container.textContent).not.toContain("Download proof bundle");
    expect(container.textContent).not.toContain("database shard alpha");
    expect(notifyParent).toHaveBeenCalledWith({
      type: "postwave:error",
      message: "Audit evidence is temporarily behind a release hold.",
      status: 503,
    });
  });

  it("makes the hold terminal and suppresses a late proof-download side effect", async () => {
    const proof = deferred<
      ApiResult<{ blob: Blob; filename: string }>
    >();
    const listAudit = vi
      .fn<PortalApiClient["listAudit"]>()
      .mockResolvedValueOnce({
        ok: true,
        data: { rows: [row], nextCursor: "next-page" },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        error: "do not reflect this message",
      });
    const downloadAivsBundle = vi.fn(() => proof.promise);
    const api = createApi({ listAudit, downloadAivsBundle });
    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });

    const { container } = await renderPortal(api);
    expect(container.textContent).toContain("user.login");

    const sessionInput = container.querySelector<HTMLInputElement>(
      "#audit-session-id",
    );
    expect(sessionInput).not.toBeNull();
    act(() => {
      if (!sessionInput) return;
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(sessionInput, "agent-session-7");
      sessionInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => buttonNamed(container, "Download proof bundle").click());
    expect(downloadAivsBundle).toHaveBeenCalledWith("agent-session-7");

    act(() => buttonNamed(container, "Load more").click());
    await settle();
    expect(container.textContent).toContain(
      "Audit evidence is not available in this portal",
    );
    expect(container.textContent).not.toContain("user.login");
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("input")).toBeNull();

    await act(async () => {
      proof.resolve({
        ok: true,
        data: { blob: new Blob(["proof"]), filename: "proof.tar.gz" },
      });
      await proof.promise;
    });
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("treats the proof endpoint's 503 as the same terminal hold and ignores a late page", async () => {
    const nextPage = deferred<ApiResult<ListAuditResponse>>();
    const listAudit = vi
      .fn<PortalApiClient["listAudit"]>()
      .mockResolvedValueOnce({
        ok: true,
        data: { rows: [row], nextCursor: "next-page" },
      })
      .mockImplementationOnce(() => nextPage.promise);
    const downloadAivsBundle = vi
      .fn<PortalApiClient["downloadAivsBundle"]>()
      .mockResolvedValue({
        ok: false,
        status: 503,
        error: "internal proof service detail",
      });
    const { container, notifyParent } = await renderPortal(
      createApi({ listAudit, downloadAivsBundle }),
    );

    act(() => buttonNamed(container, "Load more").click());
    const sessionInput = container.querySelector<HTMLInputElement>(
      "#audit-session-id",
    );
    act(() => {
      if (!sessionInput) return;
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(sessionInput, "agent-session-8");
      sessionInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => buttonNamed(container, "Download proof bundle").click());
    await settle();

    expect(container.textContent).toContain(
      "Audit evidence is not available in this portal",
    );
    expect(container.textContent).not.toContain("internal proof service detail");
    expect(container.querySelector("table")).toBeNull();
    expect(notifyParent).toHaveBeenCalledWith({
      type: "postwave:error",
      message: "Audit evidence is temporarily behind a release hold.",
      status: 503,
    });

    await act(async () => {
      nextPage.resolve({
        ok: true,
        data: {
          rows: [{ ...row, id: 8, action: "tenant.updated" }],
          nextCursor: null,
        },
      });
      await nextPage.promise;
    });
    expect(container.textContent).not.toContain("tenant.updated");
    expect(container.querySelector("table")).toBeNull();
  });

  it.each([
    {
      label: "authentication",
      status: 401,
      heading: "This portal session needs a new link",
      absentHeading: "The portal service cannot be reached",
    },
    {
      label: "network",
      status: undefined,
      heading: "The portal service cannot be reached",
      absentHeading: "This portal session needs a new link",
    },
  ])(
    "distinguishes a $label failure without reflecting raw server text",
    async ({ status, heading, absentHeading }) => {
      const listAudit = vi.fn(async () => ({
        ok: false as const,
        status,
        error: "unsafe raw gateway and tenant detail",
      }));
      const { container } = await renderPortal(createApi({ listAudit }));

      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(container.textContent).toContain(heading);
      expect(container.textContent).not.toContain(absentHeading);
      expect(container.textContent).not.toContain("unsafe raw gateway");
      expect(container.querySelector("table")).toBeNull();
      expect(container.querySelector("button")).toBeNull();
      expect(listAudit).toHaveBeenCalledTimes(1);
    },
  );

  it("does not render an empty table or an End of log control for a successful empty result", async () => {
    const response: ApiResult<ListAuditResponse> = {
      ok: true,
      data: { rows: [], nextCursor: null },
    };
    const { container } = await renderPortal(
      createApi({ listAudit: vi.fn(async () => response) }),
    );

    expect(container.textContent).toContain("No activity returned");
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).not.toContain("0 events");
    expect(container.textContent).not.toContain("End of log");
    expect(container.querySelector('button[type="button"]')?.textContent).toBe(
      "Download proof bundle",
    );
  });
});

describe("AuditPortal boot handoff", () => {
  it("renders the page App already fetched instead of asking for it again", async () => {
    const listAudit = vi
      .fn<PortalApiClient["listAudit"]>()
      .mockResolvedValue({ ok: true, data: { rows: [], nextCursor: null } });
    const { container } = await renderPortal(createApi({ listAudit }), vi.fn(), {
      ok: true,
      data: { rows: [row], nextCursor: "cursor-2" },
    });

    expect(listAudit).not.toHaveBeenCalled();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.textContent).toContain("1 loaded");
    // Formatting the timestamp through one hoisted Intl formatter must not
    // change what the auditor reads.
    expect(container.querySelector("tbody td")?.textContent).toBe(
      new Date(row.at).toLocaleString(),
    );

    // The handoff must leave paging intact: "Load more" still asks the API.
    await act(async () => {
      buttonNamed(container, "Load more").click();
      await Promise.resolve();
    });
    expect(listAudit).toHaveBeenCalledWith({
      limit: PORTAL_PAGE_SIZE,
      cursor: "cursor-2",
      action: undefined,
    });
  });

  it("carries a prefetched failure into the same terminal state a live one produces", async () => {
    const listAudit = vi.fn<PortalApiClient["listAudit"]>();
    const { container, notifyParent } = await renderPortal(
      createApi({ listAudit }),
      vi.fn(),
      { ok: false, status: 503, error: "unsafe raw gateway detail" },
    );

    expect(listAudit).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Audit evidence is not available in this portal",
    );
    expect(container.textContent).not.toContain("unsafe raw gateway detail");
    expect(notifyParent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "postwave:error", status: 503 }),
    );
  });

  it("still fetches for itself when no page was handed over", async () => {
    const listAudit = vi
      .fn<PortalApiClient["listAudit"]>()
      .mockResolvedValue({ ok: true, data: { rows: [row], nextCursor: null } });
    await renderPortal(createApi({ listAudit }));
    expect(listAudit).toHaveBeenCalledTimes(1);
  });
});
