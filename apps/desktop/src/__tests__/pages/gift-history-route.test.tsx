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

const mocks = vi.hoisted(() => ({
  getGiftSubscription: vi.fn(),
  getGiftSubscriptionStats: vi.fn(),
  listGiftSubscriptions: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    apiMonetization: {
      ...actual.apiMonetization,
      getGiftSubscription: mocks.getGiftSubscription,
      getGiftSubscriptionStats: mocks.getGiftSubscriptionStats,
      listGiftSubscriptions: mocks.listGiftSubscriptions,
    },
  };
});

import { GiftSubscriptions } from "../../pages/GiftSubscriptions";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_AT = "2026-07-27T10:00:00.000Z";

function wireRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: FIRST_ID,
    label: "Gift record 11111111",
    plan_label: "Studio annual",
    duration_months: 12,
    status: "paid",
    created_at: "2026-07-01T09:00:00.000Z",
    redeemed_at: null,
    expires_at: "2027-07-01T09:00:00.000Z",
    canceled_at: null,
    message_recorded: true,
    provider_invoice_linked: true,
    gifter_member_linked: false,
    recipient_member_linked: true,
    ...overrides,
  };
}

function pageResponse(
  items: unknown[],
  options: { limit?: number; offset?: number; total?: number } = {},
): {
  data: {
    items: unknown[];
    total: number;
    limit: number;
    offset: number;
    snapshot_at: string;
  };
} {
  return {
    data: {
      items,
      total: options.total ?? items.length,
      limit: options.limit ?? 18,
      offset: options.offset ?? 0,
      snapshot_at: SNAPSHOT_AT,
    },
  };
}

function statsResponse(overrides: Record<string, unknown> = {}): {
  data: Record<string, unknown>;
} {
  return {
    data: {
      total: 2,
      pending: 0,
      paid: 1,
      granted: 1,
      canceled: 0,
      expired: 0,
      refunded: 0,
      conversionRate: 1,
      generated_at: SNAPSHOT_AT,
      ...overrides,
    },
  };
}

const populatedRows = [
  wireRecord(),
  wireRecord({
    id: SECOND_ID,
    label: "Gift record 22222222",
    plan_label: "Essentials",
    duration_months: 3,
    status: "redeemed",
    created_at: "2026-06-01T09:00:00.000Z",
    redeemed_at: "2026-06-02T09:00:00.000Z",
    provider_invoice_linked: false,
  }),
];

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listGiftSubscriptions.mockResolvedValue(pageResponse(populatedRows));
  mocks.getGiftSubscriptionStats.mockResolvedValue(statsResponse());
  mocks.getGiftSubscription.mockImplementation((recordID: string) =>
    Promise.resolve({
      data:
        populatedRows.find((candidate) => candidate.id === recordID) ??
        wireRecord({ id: recordID }),
    }),
  );
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function renderRoute(element: ReactElement = <GiftSubscriptions />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(name: string | RegExp): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => {
    const accessibleName =
      candidate.getAttribute("aria-label") ??
      candidate.textContent?.replace(/\s+/gu, " ").trim() ??
      "";
    return typeof name === "string"
      ? accessibleName === name
      : name.test(accessibleName);
  });
  if (!match) throw new Error(`Missing button: ${String(name)}`);
  return match;
}

function click(target: HTMLElement): void {
  act(() => target.click());
}

function setInput(target: HTMLInputElement, value: string): void {
  act(() => {
    Reflect.set(HTMLInputElement.prototype, "value", value, target);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelect(target: HTMLSelectElement, value: string): void {
  act(() => {
    Reflect.set(HTMLSelectElement.prototype, "value", value, target);
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function seriousOrCritical(results: axe.AxeResults): axe.Result[] {
  return results.violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical",
  );
}

describe("Gift history route", () => {
  it("moves from a truthful loading state to the complete sanitized archive", async () => {
    const pending = deferred<ReturnType<typeof pageResponse>>();
    mocks.listGiftSubscriptions.mockImplementationOnce(() => pending.promise);

    renderRoute();

    expect(
      document.querySelector('[aria-label="Loading gift history"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      "Verifying gift lifecycle records",
    );
    expect(document.querySelector(".ghs-card-grid")).toBeNull();

    pending.resolve(pageResponse(populatedRows));
    await settle();

    expect(mocks.listGiftSubscriptions).toHaveBeenCalledWith({
      limit: 18,
      offset: 0,
      q: undefined,
      filter: "all",
      sort: "newest",
    });
    expect(mocks.getGiftSubscriptionStats).toHaveBeenCalledOnce();
    expect(
      document.querySelector("#gift-history-title")?.textContent,
    ).toContain("moved from intention to access");
    expect(document.querySelectorAll(".ghs-card")).toHaveLength(2);
    expect(document.body.textContent).toContain("Gift record 11111111");
    expect(document.body.textContent).toContain("Gift record 22222222");
    expect(document.body.textContent).toContain("Sanitized projection");
    expect(document.body.textContent).toContain(
      "Historical inspection is the complete route boundary.",
    );
  });

  it("sanitizes search input and forwards bounded search, lifecycle, and sort controls", async () => {
    renderRoute();
    await settle();

    const search = document.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    const selects =
      document.querySelectorAll<HTMLSelectElement>(".ghs-select select");
    if (!search || selects.length !== 2) {
      throw new Error("Missing gift history controls");
    }

    const callsBeforeInvalidInput =
      mocks.listGiftSubscriptions.mock.calls.length;
    setInput(search, "1111@example!.com\u202e");
    await settle();
    expect(search.value).toBe("1111@example!.com");
    expect(search.getAttribute("aria-invalid")).toBe("true");
    expect(document.body.textContent).toContain(
      "nothing is sent until the prefix is valid.",
    );
    expect(mocks.listGiftSubscriptions).toHaveBeenCalledTimes(
      callsBeforeInvalidInput,
    );

    setInput(search, "Gift record 11111111");
    await settle();
    expect(search.getAttribute("aria-invalid")).toBe("false");
    expect(mocks.listGiftSubscriptions).toHaveBeenLastCalledWith({
      limit: 18,
      offset: 0,
      q: "11111111",
      filter: "all",
      sort: "newest",
    });

    const callsBeforeInvalidEdit =
      mocks.listGiftSubscriptions.mock.calls.length;
    setInput(search, "Gift record 1111111x");
    await settle();
    expect(search.getAttribute("aria-invalid")).toBe("true");
    expect(document.body.textContent).toContain(
      "The current result stays in place",
    );
    expect(mocks.listGiftSubscriptions).toHaveBeenCalledTimes(
      callsBeforeInvalidEdit,
    );
    expect(mocks.listGiftSubscriptions).toHaveBeenLastCalledWith({
      limit: 18,
      offset: 0,
      q: "11111111",
      filter: "all",
      sort: "newest",
    });

    setSelect(selects[0]!, "closed");
    await settle();
    expect(mocks.listGiftSubscriptions).toHaveBeenLastCalledWith({
      limit: 18,
      offset: 0,
      q: "11111111",
      filter: "closed",
      sort: "newest",
    });

    setSelect(selects[1]!, "duration");
    await settle();
    expect(mocks.listGiftSubscriptions).toHaveBeenLastCalledWith({
      limit: 18,
      offset: 0,
      q: "11111111",
      filter: "closed",
      sort: "duration",
    });

    click(button("Clear gift record search"));
    await settle();
    expect(search.value).toBe("");
    expect(mocks.listGiftSubscriptions).toHaveBeenLastCalledWith({
      limit: 18,
      offset: 0,
      q: undefined,
      filter: "closed",
      sort: "duration",
    });
  });

  it("requests the next bounded server page and preserves exact pagination truth", async () => {
    mocks.listGiftSubscriptions.mockImplementation(
      (options: { offset?: number }) =>
        Promise.resolve(
          options.offset === 18
            ? pageResponse(
                [
                  wireRecord({
                    id: "33333333-3333-4333-8333-333333333333",
                    label: "Gift record 33333333",
                  }),
                  wireRecord({
                    id: "44444444-4444-4444-8444-444444444444",
                    label: "Gift record 44444444",
                  }),
                ],
                { total: 20, offset: 18 },
              )
            : pageResponse(populatedRows, { total: 20 }),
        ),
    );

    renderRoute();
    await settle();
    expect(document.body.textContent).toContain("Showing 1–2 of 20");
    expect(document.body.textContent).toContain("Page 1 of 2");

    click(button("Next"));
    await settle();

    expect(mocks.listGiftSubscriptions).toHaveBeenLastCalledWith({
      limit: 18,
      offset: 18,
      q: undefined,
      filter: "all",
      sort: "newest",
    });
    expect(document.body.textContent).toContain("Showing 19–20 of 20");
    expect(document.body.textContent).toContain("Page 2 of 2");
    expect(document.body.textContent).toContain("Gift record 33333333");
    expect(document.body.textContent).not.toContain("Gift record 11111111");
  });

  it("keeps page-local integrity review navigable and stops at the server window", async () => {
    mocks.listGiftSubscriptions.mockImplementation(
      (options: { offset?: number }) =>
        Promise.resolve(
          options.offset === 18
            ? pageResponse(
                [
                  wireRecord({
                    id: "33333333-3333-4333-8333-333333333333",
                    label: "Gift record 33333333",
                  }),
                ],
                { total: 20, offset: 18 },
              )
            : pageResponse(populatedRows, { total: 20 }),
        ),
    );
    renderRoute();
    await settle();

    const lifecycle =
      document.querySelectorAll<HTMLSelectElement>(".ghs-select select")[0];
    if (!lifecycle) throw new Error("Missing lifecycle control");
    setSelect(lifecycle, "data_issue");
    await settle();

    expect(document.body.textContent).toContain(
      "No readable field issues appear on this page.",
    );
    expect(document.body.textContent).toContain(
      "This review mode is page-local.",
    );
    expect(document.querySelector(".ghs-pagination")).not.toBeNull();
    click(button("Next"));
    await settle();
    expect(mocks.listGiftSubscriptions).toHaveBeenLastCalledWith({
      limit: 18,
      offset: 18,
      q: undefined,
      filter: undefined,
      sort: "newest",
    });

    mocks.listGiftSubscriptions.mockResolvedValueOnce(
      pageResponse([wireRecord()], {
        total: 20_000,
        limit: 18,
        offset: 9_990,
      }),
    );
    setSelect(lifecycle, "all");
    await settle();
    expect(document.body.textContent).toContain("archive window limit reached");
    expect(button("Next").disabled).toBe(true);
  });

  it("distinguishes a true empty archive, an initial failure, and recovery", async () => {
    mocks.listGiftSubscriptions.mockResolvedValueOnce(pageResponse([]));
    mocks.getGiftSubscriptionStats.mockResolvedValueOnce(
      statsResponse({
        total: 0,
        pending: 0,
        paid: 0,
        granted: 0,
        conversionRate: 0,
      }),
    );
    renderRoute();
    await settle();

    expect(document.body.textContent).toContain(
      "No gift lifecycle records are on file.",
    );
    expect(document.body.textContent).not.toContain(
      "No verified gift history is available.",
    );

    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
    mocks.listGiftSubscriptions
      .mockResolvedValueOnce({
        error: { kind: "network", message: "Archive unavailable" },
      })
      .mockResolvedValueOnce(pageResponse([wireRecord()]));

    renderRoute();
    await settle();
    expect(document.body.textContent).toContain(
      "No verified gift history is available.",
    );
    expect(document.body.textContent).not.toContain(
      "No gift lifecycle records are on file.",
    );

    click(button("Retry archive read"));
    await settle();
    expect(document.body.textContent).toContain("Gift record 11111111");
    expect(document.body.textContent).not.toContain(
      "No verified gift history is available.",
    );
  });

  it("retains verified record and aggregate snapshots when a refresh fails", async () => {
    renderRoute();
    await settle();
    mocks.listGiftSubscriptions.mockResolvedValueOnce({
      error: { kind: "network", message: "List transport failed" },
    });
    mocks.getGiftSubscriptionStats.mockResolvedValueOnce({
      error: { kind: "network", message: "Stats transport failed" },
    });

    click(button("Refresh evidence"));
    await settle();

    const alerts = Array.from(
      document.querySelectorAll<HTMLElement>(".ghs-retained-error[role=alert]"),
    );
    expect(alerts).toHaveLength(2);
    expect(alerts.map((alert) => alert.textContent).join(" ")).toContain(
      "verified aggregate statistics remain visible",
    );
    expect(alerts.map((alert) => alert.textContent).join(" ")).toContain(
      "verified record page remain visible",
    );
    expect(document.body.textContent).toContain("Gift record 11111111");
    expect(document.body.textContent).toContain("100.0%");
    expect(mocks.listGiftSubscriptions).toHaveBeenCalledTimes(2);
    expect(mocks.getGiftSubscriptionStats).toHaveBeenCalledTimes(2);
  });

  it("contains malformed and sensitive rows, then reviews issues without sending an unsupported filter", async () => {
    const unsafe = wireRecord({
      purchaser_email: "private@example.com",
      recipient_email: "recipient@example.com",
      message: "secret message",
      stripe_invoice_id: "in_secret",
      stripe_payment_url: "https://provider.invalid/secret",
      tenant_id: "tenant-secret",
      gifter_attribution_token: "token-secret",
    });
    mocks.listGiftSubscriptions.mockResolvedValue(
      pageResponse([wireRecord({ id: SECOND_ID }), unsafe, "bad row"], {
        total: 3,
      }),
    );

    renderRoute();
    await settle();

    const integrity = document.querySelector<HTMLElement>(
      ".ghs-integrity[role=status]",
    );
    expect(integrity?.textContent).toContain(
      "1 readable record has field warnings",
    );
    expect(integrity?.textContent).toContain(
      "1 contract-invalid row was contained",
    );
    for (const secret of [
      "private@example.com",
      "recipient@example.com",
      "secret message",
      "in_secret",
      "https://provider.invalid/secret",
      "tenant-secret",
      "token-secret",
      FIRST_ID,
      SECOND_ID,
    ]) {
      expect(document.body.textContent).not.toContain(secret);
    }

    click(button("Review this page"));
    await settle();
    expect(document.querySelectorAll(".ghs-card")).toHaveLength(1);
    expect(document.body.textContent).toContain("7 integrity warnings");
    expect(mocks.listGiftSubscriptions).toHaveBeenCalledOnce();
    expect(
      mocks.listGiftSubscriptions.mock.calls.some(
        ([options]) =>
          (options as { filter?: string } | undefined)?.filter === "data_issue",
      ),
    ).toBe(false);
  });

  it("keeps detail reads sanitized, contains failures, retries, and restores opener focus", async () => {
    mocks.getGiftSubscription
      .mockResolvedValueOnce({
        error: { kind: "network", message: "Detail unavailable" },
      })
      .mockResolvedValueOnce({
        data: wireRecord({
          purchaser_email: "purchaser@example.com",
          recipient_email: "recipient@example.com",
          message: "private detail",
          stripe_invoice_id: "in_detail_secret",
          redemption_url: "https://postwave.invalid/redeem/secret",
        }),
      });

    renderRoute();
    await settle();
    const opener = button("Inspect Gift record 11111111");
    opener.focus();
    click(opener);
    await settle();

    const dialog = document.querySelector<HTMLElement>('aside[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.textContent).toContain(
      "Refresh failed; verified record page remain visible.",
    );
    expect(dialog?.textContent).toContain("Record summary");
    expect(mocks.getGiftSubscription).toHaveBeenCalledWith(FIRST_ID);

    const retry = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((candidate) => candidate.textContent?.trim() === "Retry");
    if (!retry) throw new Error("Missing detail retry");
    click(retry);
    await settle();
    expect(mocks.getGiftSubscription).toHaveBeenCalledTimes(2);
    expect(dialog?.textContent).toContain("Data integrity warnings");

    for (const secret of [
      FIRST_ID,
      "purchaser@example.com",
      "recipient@example.com",
      "private detail",
      "in_detail_secret",
      "https://postwave.invalid/redeem/secret",
    ]) {
      expect(document.body.textContent).not.toContain(secret);
    }
    const actionNames = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    )
      .map(
        (candidate) =>
          candidate.getAttribute("aria-label") ??
          candidate.textContent?.replace(/\s+/gu, " ").trim() ??
          "",
      )
      .join(" ");
    expect(actionNames).not.toMatch(
      /\b(create|cancel|edit|refund|redeem|export|reconcile)\b/iu,
    );

    click(button("Close evidence"));
    await settle();
    expect(document.querySelector('aside[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("uses only the three archive GET owners and remains axe-clean in route and detail states", async () => {
    renderRoute();
    await settle();

    expect(mocks.listGiftSubscriptions).toHaveBeenCalledOnce();
    expect(mocks.getGiftSubscriptionStats).toHaveBeenCalledOnce();
    expect(mocks.getGiftSubscription).not.toHaveBeenCalled();
    if (!container) throw new Error("Missing rendered Gift history route");
    expect(
      seriousOrCritical(
        await axe.run(container, { resultTypes: ["violations"] }),
      ),
    ).toEqual([]);

    click(button("Inspect Gift record 11111111"));
    await settle();
    expect(mocks.getGiftSubscription).toHaveBeenCalledOnce();
    const dialog = document.querySelector<HTMLElement>('aside[role="dialog"]');
    if (!dialog) throw new Error("Missing Gift history detail dialog");
    expect(
      seriousOrCritical(await axe.run(dialog, { resultTypes: ["violations"] })),
    ).toEqual([]);
  });
});
