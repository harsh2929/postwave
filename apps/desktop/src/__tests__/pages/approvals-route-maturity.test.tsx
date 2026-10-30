// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
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

import type {
  DesktopRoute,
  DesktopRouteSnapshot,
} from "../../lib/desktop-router";

const mocks = vi.hoisted(() => ({
  canAdmin: true,
  consumeDeepLink: vi.fn(),
  decideApproval: vi.fn(),
  getApproval: vi.fn(),
  historyRows: [] as Array<Record<string, unknown>>,
  listApprovals: vi.fn(),
  navigate: vi.fn(),
  onDeepLink: vi.fn(),
  pendingRows: [] as Array<Record<string, unknown>>,
  requestBack: vi.fn(),
  requestNavigate: vi.fn(),
  routeListeners: new Set<() => void>(),
  snapshot: {
    route: { section: "approvals" },
    canonicalUrl: "/app/approvals",
    revision: 0,
    source: "navigation",
    restoreScrollTop: null,
  } as DesktopRouteSnapshot,
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    decideApproval: mocks.decideApproval,
    getApproval: mocks.getApproval,
    listApprovals: mocks.listApprovals,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
}));

vi.mock("../../lib/deep-link", () => ({
  consumePendingDeepLinkTarget: mocks.consumeDeepLink,
  onPendingDeepLinkTarget: mocks.onDeepLink,
}));

vi.mock("../../lib/desktop-router", async () => {
  const React = await import("react");
  const actual = await vi.importActual<
    typeof import("../../lib/desktop-router")
  >("../../lib/desktop-router");
  type Route = Parameters<typeof actual.serializeDesktopRoute>[0];
  type Options = Parameters<typeof actual.navigateDesktopRoute>[1];

  const applyRoute = (route: Route, options: Options = {}): void => {
    mocks.snapshot = {
      route,
      canonicalUrl: actual.serializeDesktopRoute(route),
      revision: mocks.snapshot.revision + 1,
      source: options.source ?? "navigation",
      restoreScrollTop: null,
    };
    for (const listener of mocks.routeListeners) listener();
  };
  mocks.navigate.mockImplementation(applyRoute);
  mocks.requestNavigate.mockImplementation(
    async (route: Route, options?: Options) => {
      applyRoute(route, options);
      return "proceeded";
    },
  );
  mocks.requestBack.mockImplementation(async (route: Route) => {
    applyRoute(route, { source: "history" });
    return "proceeded";
  });

  const useSnapshot = () =>
    React.useSyncExternalStore(
      (listener) => {
        mocks.routeListeners.add(listener);
        return () => mocks.routeListeners.delete(listener);
      },
      () => mocks.snapshot,
      () => mocks.snapshot,
    );

  return {
    ...actual,
    getDesktopRoute: () => mocks.snapshot.route,
    navigateDesktopRoute: mocks.navigate,
    requestDesktopRouteBackNavigation: mocks.requestBack,
    requestDesktopRouteNavigation: mocks.requestNavigate,
    useDesktopRoute: () => useSnapshot().route,
    useDesktopRouteSnapshot: useSnapshot,
    useDesktopRouteTab: <Value extends string>(
      section: string,
      allowed: readonly Value[],
      fallback: Value,
    ) => {
      const route = useSnapshot().route;
      const active =
        route.section === section &&
        route.tab !== undefined &&
        allowed.includes(route.tab as Value)
          ? (route.tab as Value)
          : fallback;
      const setTab = (next: Value): void => {
        if (!allowed.includes(next)) return;
        const current = mocks.snapshot.route;
        const base = current.section === section ? current : { section };
        applyRoute({
          ...base,
          ...(next === fallback ? { tab: undefined } : { tab: next }),
        } as Route);
      };
      return [active, setTab] as const;
    },
  };
});

vi.mock("../../components/ApprovalDetailSlideover", () => ({
  ApprovalDetailSlideover: ({
    row,
    onClose,
    onReject,
  }: {
    row: Record<string, unknown> & { id: string };
    onClose: () => void;
    onReject?: (row: Record<string, unknown> & { id: string }) => void;
  }) => (
    <div role="dialog" aria-label="Approval detail test boundary">
      Exact detail {row.id}
      {onReject ? (
        <button type="button" onClick={() => onReject(row)}>
          Reject request
        </button>
      ) : null}
      <button type="button" onClick={onClose}>
        Close detail
      </button>
    </div>
  ),
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    info: vi.fn(),
  },
}));

vi.mock("../../lib/heroAssets", () => ({
  HERO: { approvals: "approvals-hero.webp" },
}));

import { Approvals } from "../../pages/Approvals";
import { REJECTION_REASON_LIMIT } from "../../pages/approvals/useApprovalsController";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const ACTIONABLE_TEST_EXPIRY = "2100-01-01T00:00:00.000Z";

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function approval(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    resourceType: "campaign",
    resourceId: `campaign-${id}`,
    requestedByActorLabel: `Requester ${id}`,
    status: "pending",
    requestedAt: "2026-08-11T08:00:00Z",
    expiresAt: ACTIONABLE_TEST_EXPIRY,
    notes: `Review context ${id}`,
    ...overrides,
  };
}

function resetRoute(route: DesktopRoute = { section: "approvals" }): void {
  mocks.snapshot = {
    route,
    canonicalUrl:
      route.section === "approvals"
        ? "/app/approvals"
        : `/app/${route.section}`,
    revision: 0,
    source: "navigation",
    restoreScrollTop: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAdmin = true;
  mocks.routeListeners.clear();
  mocks.pendingRows = [approval("pending-one")];
  mocks.historyRows = [
    approval("approved-one", {
      status: "approved",
      decidedAt: "2026-08-11T09:00:00Z",
    }),
    approval("rejected-one", {
      status: "rejected",
      decidedAt: "2026-08-11T09:30:00Z",
    }),
  ];
  resetRoute();
  mocks.consumeDeepLink.mockReturnValue(null);
  mocks.onDeepLink.mockReturnValue(() => undefined);
  mocks.listApprovals.mockImplementation(
    async ({ includeResolved }: { includeResolved?: boolean }) => ({
      data: {
        approvals: includeResolved ? mocks.historyRows : mocks.pendingRows,
      },
    }),
  );
  mocks.decideApproval.mockResolvedValue({
    data: approval("pending-one", {
      status: "rejected",
      decidedAt: "2026-08-11T09:45:00Z",
    }),
  });
  mocks.getApproval.mockImplementation(async (id: string) => ({
    data:
      mocks.pendingRows.find((row) => row.id === id) ??
      mocks.historyRows.find((row) => row.id === id) ??
      approval(id),
  }));
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

function render(node: ReactElement = <Approvals />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function bodyText(): string {
  return document.body.textContent ?? "";
}

function activePanel(): HTMLElement {
  const panel = document.querySelector<HTMLElement>(
    '[role="tabpanel"]:not([hidden])',
  );
  if (!panel) throw new Error("Missing active approval tab panel");
  return panel;
}

function button(
  label: string,
  owner: ParentNode = document,
): HTMLButtonElement {
  const match = Array.from(
    owner.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function tab(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).find((candidate) => candidate.textContent?.includes(label));
  if (!match) throw new Error(`Missing tab: ${label}`);
  return match;
}

function labelledControl<
  ElementType extends
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement,
>(label: string, owner: ParentNode = document): ElementType {
  const labelNode = Array.from(
    owner.querySelectorAll<HTMLLabelElement>("label"),
  ).find((candidate) => candidate.textContent?.trim().startsWith(label));
  const associated = labelNode?.htmlFor
    ? document.getElementById(labelNode.htmlFor)
    : null;
  const control =
    (associated as ElementType | null) ??
    labelNode?.querySelector<ElementType>("input, select, textarea");
  if (!control) throw new Error(`Missing control: ${label}`);
  return control;
}

function setValue(
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      control,
      value,
    );
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

function openFirstRejection(): void {
  const row = document.querySelector<HTMLElement>(
    '[data-approval-id="pending-one"]',
  );
  if (!row) throw new Error("Missing first pending approval");
  act(() => button("Details", row).click());
  act(() => button("Reject request").click());
}

describe("Approvals route access and response integrity", () => {
  it("sends zero approval reads for viewers and clears a routed detail", async () => {
    mocks.canAdmin = false;
    resetRoute({
      section: "approvals",
      overlay: { name: "approval-detail", resourceId: "approval-secret" },
    });
    render();
    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith(
        { section: "approvals" },
        { replace: true, source: "navigation" },
      );
    });

    expect(mocks.listApprovals).not.toHaveBeenCalled();
    expect(mocks.decideApproval).not.toHaveBeenCalled();
    expect(mocks.snapshot.route.overlay).toBeUndefined();
    expect(bodyText()).toContain(
      "Your current role cannot open the approval queue",
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("treats a malformed admin response as unavailable, never verified empty", async () => {
    mocks.listApprovals.mockResolvedValue({ data: {} });
    render();
    await waitFor(() => {
      expect(bodyText()).toContain("Approval evidence unavailable");
    });

    expect(bodyText()).not.toContain("Nothing is waiting in the loaded queue.");
    expect(mocks.listApprovals).toHaveBeenCalledWith({
      includeResolved: false,
      limit: 200,
    });
    expect(mocks.listApprovals).toHaveBeenCalledWith({
      includeResolved: true,
      limit: 200,
    });
  });

  it("rejects an oversized server window instead of truncating it", async () => {
    mocks.pendingRows = Array.from({ length: 201 }, (_, index) =>
      approval(`pending-${index}`),
    );
    render();
    await waitFor(() => {
      expect(bodyText()).toContain("Approval evidence unavailable");
    });
    expect(bodyText()).not.toContain("Showing 200");
    expect(document.querySelector(".approvals-table")).toBeNull();
  });

  it("marks retained History metrics stale when only their refresh fails", async () => {
    let historyReads = 0;
    mocks.listApprovals.mockImplementation(
      async ({ includeResolved }: { includeResolved?: boolean }) => {
        if (!includeResolved) return { data: { approvals: mocks.pendingRows } };
        historyReads += 1;
        return historyReads === 1
          ? { data: { approvals: mocks.historyRows } }
          : {
              error: {
                kind: "network" as const,
                message: "History metrics could not be refreshed.",
              },
            };
      },
    );
    render();
    await waitFor(() => {
      expect(bodyText()).toContain("campaign-pending-one");
      expect(button("Refresh evidence")).toBeTruthy();
    });

    await act(async () => button("Refresh evidence").click());
    await waitFor(() => {
      expect(bodyText()).toContain("Showing retained, stale history metrics");
    });

    expect(activePanel().textContent).toContain("campaign-pending-one");
    expect(bodyText()).toContain("Stale · 1");
    expect(bodyText()).toContain(
      "The History read failed, so this value is retained and stale.",
    );
  });

  it("renders unknown resource/status truth with no raw value or decision control", async () => {
    const resourceCanary = "future_resource_canary";
    const statusCanary = "future_status_canary";
    mocks.pendingRows = [
      approval("pending-unknown-resource", { resourceType: resourceCanary }),
    ];
    mocks.historyRows = [
      approval("history-unknown-status", { status: statusCanary }),
    ];
    render();
    await waitFor(() => {
      expect(bodyText()).toContain("campaign-pending-unknown-resource");
    });
    expect(activePanel().textContent).toContain("Resource");
    expect(activePanel().textContent).not.toContain(resourceCanary);
    expect(
      Array.from(activePanel().querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Reject",
      ),
    ).toBe(false);

    act(() => tab("History").click());
    await waitFor(() => {
      expect(activePanel().textContent).toContain("Status unverified");
    });
    expect(activePanel().textContent).not.toContain(statusCanary);
    expect(activePanel().querySelector(".btn-danger")).toBeNull();
  });

  it("unmounts privileged state and clears detail on role downgrade", async () => {
    render();
    await waitFor(() => {
      expect(activePanel().textContent).toContain("campaign-pending-one");
    });
    act(() => button("Details", activePanel()).click());
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });
    const readsBeforeDowngrade = mocks.listApprovals.mock.calls.length;

    mocks.canAdmin = false;
    act(() => root?.render(<Approvals />));
    await waitFor(() => {
      expect(mocks.snapshot.route.overlay).toBeUndefined();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();

    expect(mocks.listApprovals).toHaveBeenCalledTimes(readsBeforeDowngrade);
    expect(bodyText()).toContain("No prior admin snapshot remains mounted");
  });
});

describe("Approvals URL-backed workspace and accessibility", () => {
  it("persists pending/history search, status, and sort in the canonical route", async () => {
    mocks.pendingRows = [
      approval("pending-alpha", { resourceId: "campaign-alpha" }),
      approval("pending-zulu", { resourceId: "campaign-zulu" }),
    ];
    render();
    await waitFor(() => {
      expect(activePanel().textContent).toContain("campaign-zulu");
    });

    const search = labelledControl<HTMLInputElement>(
      "Search loaded records",
      activePanel(),
    );
    setValue(search, "zulu");
    act(() => button("Apply search", activePanel()).click());
    await waitFor(() => {
      expect(mocks.snapshot.route.query).toBe("zulu");
      expect(activePanel().textContent).not.toContain("campaign-alpha");
    });
    expect(mocks.snapshot.canonicalUrl).toBe("/app/approvals?q=zulu");

    act(() => tab("History").click());
    await waitFor(() => expect(mocks.snapshot.route.tab).toBe("history"));
    const historyPanel = activePanel();
    setValue(
      labelledControl<HTMLSelectElement>("Status", historyPanel),
      "rejected",
    );
    setValue(
      labelledControl<HTMLSelectElement>("Sort", historyPanel),
      "oldest",
    );
    await waitFor(() => {
      expect(mocks.snapshot.route.filters).toEqual([
        { key: "status", value: "rejected" },
      ]);
      expect(mocks.snapshot.route.sort).toEqual({
        field: "requested",
        direction: "asc",
      });
    });
    expect(mocks.snapshot.canonicalUrl).toBe(
      "/app/approvals?tab=history&q=zulu&sort=requested&dir=asc&f.status=rejected",
    );
  });

  it("clears the history-only status sort when returning to pending", async () => {
    resetRoute({
      section: "approvals",
      tab: "history",
      sort: { field: "status", direction: "asc" },
    });
    render();
    await waitFor(() => {
      expect(tab("History").getAttribute("aria-selected")).toBe("true");
    });
    await act(async () => {
      tab("Pending").click();
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await waitFor(() => {
      expect(tab("Pending").getAttribute("aria-selected")).toBe("true");
    });
    await flush();

    expect(mocks.snapshot.route.sort).toBeUndefined();
    expect(
      labelledControl<HTMLSelectElement>("Sort", activePanel()).value,
    ).toBe("newest");
  });

  it("repairs a direct pending URL that carries hidden history-only controls", async () => {
    resetRoute({
      section: "approvals",
      filters: [{ key: "status", value: "rejected" }],
      sort: { field: "status", direction: "asc" },
    });
    render();
    await waitFor(() => {
      expect(tab("Pending").getAttribute("aria-selected")).toBe("true");
      expect(mocks.snapshot.route.filters).toBeUndefined();
      expect(mocks.snapshot.route.sort).toBeUndefined();
    });

    expect(
      labelledControl<HTMLSelectElement>("Sort", activePanel()).value,
    ).toBe("newest");
  });

  it("implements manual APG tabs and is WCAG 2.x A/AA clean in every workspace", async () => {
    render();
    await waitFor(() => {
      expect(activePanel().querySelector(".approvals-table")).not.toBeNull();
    });
    const tabs = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    expect(tabs).toHaveLength(3);
    expect(tab("Pending").getAttribute("aria-selected")).toBe("true");
    expect(tab("Pending").tabIndex).toBe(0);
    expect(tab("History").tabIndex).toBe(-1);

    await act(async () => {
      tab("Pending").focus();
      tab("Pending").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(tab("History"));
    expect(tab("Pending").getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      tab("History").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await waitFor(() => {
      expect(tab("History").getAttribute("aria-selected")).toBe("true");
    });

    for (const label of ["History", "Governance", "Pending"]) {
      if (tab(label).getAttribute("aria-selected") !== "true") {
        await act(async () => {
          tab(label).click();
          await Promise.resolve();
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
        await waitFor(() => {
          expect(tab(label).getAttribute("aria-selected")).toBe("true");
        });
      }
      const selected = tab(label);
      const panelId = selected.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby")).toBe(selected.id);
      expect(panel?.hasAttribute("hidden")).toBe(false);
      expect(
        document.querySelectorAll(
          '.approvals-tab-panel:not([hidden]) [role="search"]',
        ),
      ).toHaveLength(label === "Governance" ? 0 : 1);
      expect(
        document.querySelectorAll(
          '.approvals-tab-panel[hidden] input, .approvals-tab-panel[hidden] select, .approvals-tab-panel[hidden] [role="status"]',
        ),
      ).toHaveLength(0);
      const result = await axe.run(container ?? document.body, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
        },
      });
      expect(result.violations).toEqual([]);
      await flush();
    }
  });
});

describe("Approvals rejection safety", () => {
  it("associates required validation and enforces the 500-character boundary", async () => {
    render();
    await waitFor(() => {
      expect(activePanel().textContent).toContain("campaign-pending-one");
    });
    expect(activePanel().querySelector("button.btn-danger")).toBeNull();
    openFirstRejection();
    const reason = labelledControl<HTMLTextAreaElement>("Reason");
    expect(document.activeElement).toBe(reason);

    act(() => button("Record rejection").click());
    await waitFor(() => {
      expect(reason.getAttribute("aria-invalid")).toBe("true");
    });
    const describedBy =
      reason.getAttribute("aria-describedby")?.split(" ") ?? [];
    const alert = Array.from(
      document.querySelectorAll<HTMLElement>('[role="alert"]'),
    ).find((candidate) => describedBy.includes(candidate.id));
    expect(alert?.textContent).toContain("Add a reason");
    expect(alert?.id && describedBy).toContain(alert?.id);
    expect(mocks.decideApproval).not.toHaveBeenCalled();

    setValue(reason, "x".repeat(REJECTION_REASON_LIMIT + 100));
    expect(reason.value).toHaveLength(REJECTION_REASON_LIMIT);
    expect(bodyText()).toContain(
      `${REJECTION_REASON_LIMIT}/${REJECTION_REASON_LIMIT}`,
    );
    expect(reason.getAttribute("aria-invalid")).toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["elapsed", "2026-08-11T07:59:59Z"],
  ])(
    "sends no rejection when exact preflight finds a %s expiry",
    async (_label, expiresAt) => {
      mocks.getApproval.mockResolvedValue({
        data: approval("pending-one", { expiresAt }),
      });
      render();
      await waitFor(() => {
        expect(activePanel().textContent).toContain("campaign-pending-one");
      });
      openFirstRejection();
      setValue(
        labelledControl<HTMLTextAreaElement>("Reason"),
        "Correct the expired gate",
      );
      act(() => button("Record rejection").click());
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));

      expect(mocks.getApproval).toHaveBeenCalledWith("pending-one");
      expect(mocks.decideApproval).not.toHaveBeenCalled();
      expect(String(mocks.toastError.mock.calls[0]?.[0])).toContain(
        "No decision was sent",
      );
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    },
  );

  it("keeps the form retryable when exact preflight is unavailable", async () => {
    const providerCanary = "INTERNAL_PREFLIGHT_PROVIDER_CANARY";
    mocks.getApproval.mockResolvedValue({
      error: { message: providerCanary, status: 503 },
    });
    render();
    await waitFor(() => {
      expect(activePanel().textContent).toContain("campaign-pending-one");
    });
    openFirstRejection();
    setValue(
      labelledControl<HTMLTextAreaElement>("Reason"),
      "Correct the gate",
    );
    act(() => button("Record rejection").click());
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));

    expect(mocks.decideApproval).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    const message = String(mocks.toastError.mock.calls[0]?.[0]);
    expect(message).toContain("No rejection was sent");
    expect(message).not.toContain(providerCanary);
  });

  it("permits only one global decision request under same-tick re-entry", async () => {
    const decision = deferred<{ data: Record<string, unknown> }>();
    mocks.decideApproval.mockReturnValue(decision.promise);
    render();
    await waitFor(() => {
      expect(activePanel().textContent).toContain("campaign-pending-one");
    });
    openFirstRejection();
    setValue(
      labelledControl<HTMLTextAreaElement>("Reason"),
      "Audience mismatch",
    );
    const submit = button("Record rejection");
    act(() => {
      submit.click();
      submit.click();
    });
    await waitFor(() => expect(mocks.getApproval).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.decideApproval).toHaveBeenCalledTimes(1));

    decision.resolve({
      data: approval("pending-one", {
        status: "rejected",
        decidedAt: "2026-08-11T09:45:00Z",
      }),
    });
    await flush();
  });

  it("redacts an unknown server error and retains only a safe request reference", async () => {
    const canary = "postgres://admin:secret@internal/approval-canary";
    mocks.decideApproval.mockResolvedValue({
      error: {
        code: "new_server_error",
        requestId: "req-safe-35",
        message: canary,
      },
    });
    render();
    await waitFor(() => {
      expect(activePanel().textContent).toContain("campaign-pending-one");
    });
    openFirstRejection();
    setValue(
      labelledControl<HTMLTextAreaElement>("Reason"),
      "Correct the scope",
    );
    act(() => button("Record rejection").click());
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));

    const message = String(mocks.toastError.mock.calls[0]?.[0]);
    expect(message).toContain("approval service could not complete");
    expect(message).toContain("Reference: req-safe-35.");
    expect(message).not.toContain(canary);
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  });

  it("uses bounded success wording without claiming downstream completion", async () => {
    render();
    await waitFor(() => {
      expect(activePanel().textContent).toContain("campaign-pending-one");
    });
    openFirstRejection();
    setValue(
      labelledControl<HTMLTextAreaElement>("Reason"),
      "Correct the gate",
    );
    act(() => button("Record rejection").click());
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1));

    const message = String(mocks.toastSuccess.mock.calls[0]?.[0]);
    expect(message).toBe(
      "Rejection decision recorded. Downstream notification status is not yet verified.",
    );
    expect(message.toLowerCase()).not.toContain("completed successfully");
    expect(mocks.decideApproval).toHaveBeenCalledWith(
      "pending-one",
      "reject",
      "Correct the gate",
    );
  });

  it("does not accept a malformed or foreign 2xx decision receipt", async () => {
    mocks.decideApproval.mockResolvedValue({
      data: approval("foreign-approval", { status: "pending" }),
    });
    render();
    await waitFor(() => {
      expect(activePanel().textContent).toContain("campaign-pending-one");
    });
    openFirstRejection();
    setValue(
      labelledControl<HTMLTextAreaElement>("Reason"),
      "Correct the gate",
    );
    act(() => button("Record rejection").click());
    await waitFor(() => expect(mocks.decideApproval).toHaveBeenCalledTimes(1));
    await flush();

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  });

  it("does not let approval A completion close a newer routed detail B", async () => {
    mocks.pendingRows = [approval("approval-a"), approval("approval-b")];
    const decision = deferred<{ data: Record<string, unknown> }>();
    mocks.decideApproval.mockReturnValue(decision.promise);
    render();
    await waitFor(() => {
      expect(activePanel().textContent).toContain("campaign-approval-a");
    });
    const rowA = document.querySelector<HTMLElement>(
      '[data-approval-id="approval-a"]',
    );
    if (!rowA) throw new Error("Missing approval A row");
    act(() => button("Details", rowA).click());
    await waitFor(() => {
      expect(bodyText()).toContain("Exact detail approval-a");
    });
    act(() => button("Reject request").click());
    setValue(labelledControl<HTMLTextAreaElement>("Reason"), "Reject A only");
    act(() => button("Record rejection").click());
    await waitFor(() => expect(mocks.decideApproval).toHaveBeenCalledTimes(1));

    await act(async () => {
      await mocks.navigate({
        section: "approvals",
        overlay: { name: "approval-detail", resourceId: "approval-b" },
      });
    });
    await waitFor(() => {
      expect(bodyText()).toContain("Exact detail approval-b");
    });
    decision.resolve({
      data: approval("approval-a", {
        status: "rejected",
        decidedAt: "2026-08-11T09:45:00Z",
      }),
    });
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1));

    expect(mocks.snapshot.route.overlay).toEqual({
      name: "approval-detail",
      resourceId: "approval-b",
    });
    expect(bodyText()).toContain("Exact detail approval-b");
  });
});

describe("Approvals refresh ownership", () => {
  it("coalesces simultaneous focus and online refresh triggers into one request pair", async () => {
    render();
    await waitFor(() => expect(mocks.listApprovals).toHaveBeenCalledTimes(2));
    const refresh = deferred<{
      data: { approvals: Array<Record<string, unknown>> };
    }>();
    mocks.listApprovals.mockReturnValue(refresh.promise);

    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    await flush();
    expect(mocks.listApprovals).toHaveBeenCalledTimes(4);

    refresh.resolve({ data: { approvals: [] } });
    await flush();
  });
});
