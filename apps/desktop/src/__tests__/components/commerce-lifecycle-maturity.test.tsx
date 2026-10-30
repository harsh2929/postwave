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

import type {
  CommerceIntegration,
  CommerceLifecycleReport,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  evaluateLifecycle: vi.fn(),
  lifecycleReport: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  commerceApi: {
    evaluateLifecycle: mocks.evaluateLifecycle,
    lifecycleReport: mocks.lifecycleReport,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { LifecycleTab } from "../../components/commerce/LifecycleTab";

const storeA: CommerceIntegration = {
  id: "store-a",
  provider: "shopify",
  shop_domain: "alpha.example.test",
  status: "active",
  scopes: [],
  settings: {},
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

const storeB: CommerceIntegration = {
  ...storeA,
  id: "store-b",
  provider: "bigcommerce",
  shop_domain: "bravo.example.test",
};

function report(
  integrationId: string,
  marker = `${integrationId}_event`,
): CommerceLifecycleReport {
  return {
    integration_id: integrationId,
    generated_at: "2026-07-29T09:30:00Z",
    cart_recovery: {
      total: integrationId === storeA.id ? 11 : 22,
      by_status: { pending: 3, recovered: 2 },
    },
    back_in_stock: { total: 4, by_status: { eligible: 1, pending: 3 } },
    price_drop: { total: 5, by_status: { watching: 5 } },
    events_last_30_days: { [marker]: integrationId === storeA.id ? 31 : 47 },
    eligible_last_30_days: 6,
    notified_pending: 2,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lifecycleReport.mockImplementation(async (integrationId: string) => ({
    data: report(integrationId),
  }));
  mocks.evaluateLifecycle.mockResolvedValue({
    data: {
      back_in_stock_eligible: 3,
      price_drop_eligible: 2,
      evaluated_at: "2026-07-29T10:00:00Z",
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

function renderLifecycle({
  integrations = [storeA, storeB],
  integrationsErr = null,
  canAdmin = true,
}: {
  integrations?: CommerceIntegration[] | null;
  integrationsErr?: string | null;
  canAdmin?: boolean;
} = {}): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(
      <LifecycleTab
        integrations={integrations}
        integrationsErr={integrationsErr}
        canAdmin={canAdmin}
      />,
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
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

function buttonNamed(name: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === name);
  if (!match) throw new Error(`Missing button: ${name}`);
  return match;
}

function selectStore(id: string): void {
  const select = document.querySelector<HTMLSelectElement>(
    'select[aria-label="Lifecycle store"]',
  );
  if (!select) throw new Error("Missing lifecycle store selector");
  act(() => {
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("Commerce lifecycle report maturity", () => {
  it("renders a provenance-bounded, semantic report for viewer access", async () => {
    renderLifecycle({ canAdmin: false });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Store A Event");
    });

    const table = document.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.querySelector("caption")?.textContent).toContain(
      "alpha.example.test",
    );
    expect(table?.querySelectorAll('th[scope="row"]')).toHaveLength(3);
    expect(
      document.querySelector(
        '[role="region"][aria-label*="alpha.example.test"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector(
        'ul[aria-label="Commerce event counts in the last 30 days"]',
      ),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      "Readiness, not delivery proof",
    );
    expect(document.body.textContent).toContain("Viewer access:");
    expect(document.body.textContent).toContain(
      "An owner or admin must run eligibility evaluation",
    );
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Evaluate eligibility",
      ),
    ).toBe(false);

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("ignores a slower previous-store response after a rapid selection", async () => {
    const alpha = deferred<{ data: CommerceLifecycleReport }>();
    const bravo = deferred<{ data: CommerceLifecycleReport }>();
    mocks.lifecycleReport.mockImplementation((integrationId: string) =>
      integrationId === storeA.id ? alpha.promise : bravo.promise,
    );

    renderLifecycle();
    expect(mocks.lifecycleReport).toHaveBeenCalledWith(storeA.id);
    selectStore(storeB.id);
    await waitFor(() => {
      expect(mocks.lifecycleReport).toHaveBeenCalledWith(storeB.id);
    });

    await act(async () => {
      bravo.resolve({ data: report(storeB.id, "verified_bravo_event") });
      await bravo.promise;
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Verified Bravo Event");
    });

    await act(async () => {
      alpha.resolve({ data: report(storeA.id, "stale_alpha_event") });
      await alpha.promise;
    });
    await flush();
    expect(document.body.textContent).toContain("Verified Bravo Event");
    expect(document.body.textContent).not.toContain("Stale Alpha Event");
  });

  it("clears the old store report as soon as another store is selected", async () => {
    const bravo = deferred<{ data: CommerceLifecycleReport }>();
    mocks.lifecycleReport.mockImplementation((integrationId: string) =>
      integrationId === storeA.id
        ? Promise.resolve({ data: report(storeA.id, "old_alpha_event") })
        : bravo.promise,
    );

    renderLifecycle();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Old Alpha Event");
    });
    selectStore(storeB.id);

    expect(document.body.textContent).not.toContain("Old Alpha Event");
    expect(document.body.textContent).toContain(
      "Loading lifecycle report for bravo.example.test",
    );

    await act(async () => {
      bravo.resolve({ data: report(storeB.id, "new_bravo_event") });
      await bravo.promise;
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("New Bravo Event");
    });
  });

  it("repairs the selection when the selected integration disappears", async () => {
    renderLifecycle({ integrations: [storeA, storeB] });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Store A Event");
    });

    renderLifecycle({ integrations: [storeB] });
    expect(document.body.textContent).not.toContain("Store A Event");
    await waitFor(() => {
      expect(mocks.lifecycleReport).toHaveBeenCalledWith(storeB.id);
      expect(document.body.textContent).toContain("Store B Event");
    });

    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Lifecycle store"]',
    );
    expect(select?.value).toBe(storeB.id);
  });

  it("rejects a report whose integration provenance does not match", async () => {
    mocks.lifecycleReport.mockResolvedValue({
      data: report(storeB.id, "wrong_store_event"),
    });
    renderLifecycle({ integrations: [storeA] });

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "The service returned a report for another store",
      );
    });
    expect(document.body.textContent).not.toContain("wrong_store_event");
    expect(document.querySelector("table")).toBeNull();
  });

  it("contains malformed report counters instead of crashing the view", async () => {
    mocks.lifecycleReport.mockResolvedValue({
      data: {
        ...report(storeA.id, "malformed_report_event"),
        notified_pending: -1,
      },
    });
    renderLifecycle({ integrations: [storeA] });

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "The service returned an invalid lifecycle report",
      );
    });
    expect(document.body.textContent).not.toContain("malformed_report_event");
    expect(document.querySelector("table")).toBeNull();
  });

  it("contains a synchronous load failure and permits a verified retry", async () => {
    mocks.lifecycleReport
      .mockImplementationOnce(() => {
        throw new Error("private warehouse socket and tenant detail");
      })
      .mockResolvedValueOnce({
        data: report(storeA.id, "recovered_report_event"),
      });
    renderLifecycle({ integrations: [storeA] });

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "The lifecycle service could not be reached",
      );
    });
    expect(document.body.textContent).not.toContain("private warehouse");

    act(() => buttonNamed("Retry").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain("Recovered Report Event");
    });
  });

  it("requires an explicit preflight and single-flights evaluation", async () => {
    const evaluation = deferred<{
      data: {
        back_in_stock_eligible: number;
        price_drop_eligible: number;
        evaluated_at: string;
      };
    }>();
    mocks.evaluateLifecycle.mockReturnValue(evaluation.promise);
    renderLifecycle({ integrations: [storeA] });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Store A Event");
    });

    act(() => buttonNamed("Evaluate eligibility").click());
    expect(mocks.evaluateLifecycle).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("What it updates:");
    expect(document.body.textContent).toContain("What it does not prove:");
    expect(document.body.textContent).toContain(
      "does not prove any notification was queued, sent, or delivered",
    );

    const confirm = buttonNamed("Run evaluation");
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(mocks.evaluateLifecycle).toHaveBeenCalledTimes(1);
    expect(mocks.evaluateLifecycle).toHaveBeenCalledWith(storeA.id);

    await act(async () => {
      evaluation.resolve({
        data: {
          back_in_stock_eligible: 3,
          price_drop_eligible: 2,
          evaluated_at: "2026-07-29T10:00:00Z",
        },
      });
      await evaluation.promise;
    });
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining(
          "not notification or delivery evidence",
        ),
      }),
    );
  });

  it("settles a thrown evaluation safely and allows a deliberate retry", async () => {
    mocks.evaluateLifecycle
      .mockImplementationOnce(() => {
        throw new Error("private evaluator credential and tenant detail");
      })
      .mockResolvedValueOnce({
        data: {
          back_in_stock_eligible: 1,
          price_drop_eligible: 0,
          evaluated_at: "2026-07-29T10:00:00Z",
        },
      });
    renderLifecycle({ integrations: [storeA] });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Store A Event");
    });

    act(() => buttonNamed("Evaluate eligibility").click());
    act(() => buttonNamed("Run evaluation").click());
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledTimes(1);
      expect(buttonNamed("Run evaluation").disabled).toBe(false);
    });
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "private evaluator",
    );

    act(() => buttonNamed("Run evaluation").click());
    await waitFor(() => {
      expect(mocks.evaluateLifecycle).toHaveBeenCalledTimes(2);
      expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  it("treats a malformed success acknowledgement as ambiguous, not retryable", async () => {
    mocks.evaluateLifecycle.mockResolvedValue({
      data: {
        evaluated_at: "2026-07-29T10:00:00Z",
      },
    });
    renderLifecycle({ integrations: [storeA] });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Store A Event");
    });

    act(() => buttonNamed("Evaluate eligibility").click());
    act(() => buttonNamed("Run evaluation").click());
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Evaluation acknowledgement incomplete",
          detail: expect.stringContaining("may have completed"),
        }),
      );
      expect(mocks.lifecycleReport).toHaveBeenCalledTimes(2);
    });
    expect(mocks.evaluateLifecycle).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
