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
  listDiscountRedemptions: vi.fn(),
  listDiscounts: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    apiMonetization: {
      ...actual.apiMonetization,
      listDiscountRedemptions: mocks.listDiscountRedemptions,
      listDiscounts: mocks.listDiscounts,
    },
  };
});

import { Discounts } from "../../pages/Discounts";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const OPEN_ID = "11111111-1111-4111-8111-111111111111";
const CLOSED_ID = "22222222-2222-4222-8222-222222222222";
const CAPPED_ID = "33333333-3333-4333-8333-333333333333";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OPEN_ID,
    label: "Launch archive",
    percent_off: 20,
    amount_off_cents: null,
    currency: "USD",
    max_redemptions: 100,
    times_redeemed: 12,
    expires_at: "2099-12-31T23:59:59.000Z",
    applies_to: "both",
    created_at: "2026-07-01T09:00:00.000Z",
    ...overrides,
  };
}

const populatedRows = [
  row(),
  row({
    id: CLOSED_ID,
    label: "Expired archive",
    percent_off: null,
    amount_off_cents: 1250,
    currency: "EUR",
    max_redemptions: null,
    times_redeemed: 7,
    expires_at: "2020-01-01T00:00:00.000Z",
    applies_to: "first_payment",
    created_at: "2026-06-01T09:00:00.000Z",
  }),
  row({
    id: CAPPED_ID,
    label: "Capped archive",
    percent_off: 15,
    max_redemptions: 3,
    times_redeemed: 3,
    expires_at: null,
    applies_to: "recurring",
    created_at: "2026-05-01T09:00:00.000Z",
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
  mocks.listDiscounts.mockResolvedValue({
    data: { items: populatedRows },
  });
  mocks.listDiscountRedemptions.mockResolvedValue({
    data: { items: [] },
  });
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

function renderRoute(element: ReactElement = <Discounts />): void {
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
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function seriousOrCritical(results: axe.AxeResults): axe.Result[] {
  return results.violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical",
  );
}

describe("Discount history route", () => {
  it("moves from a truthful loading state to a populated, sortable, filterable archive", async () => {
    const pending = deferred<{
      data: { items: Array<Record<string, unknown>> };
    }>();
    mocks.listDiscounts.mockImplementationOnce(() => pending.promise);

    renderRoute();

    expect(
      document.querySelector(
        '[role="status"][aria-label="Loading discount history"]',
      ),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Reading snapshot");
    expect(
      document.querySelector('[aria-label="Discount history records"]'),
    ).toBeNull();

    pending.resolve({ data: { items: populatedRows } });
    await settle();

    expect(mocks.listDiscounts).toHaveBeenCalledOnce();
    expect(
      document.querySelector<HTMLHeadingElement>("#discount-history-title")
        ?.textContent,
    ).toContain("without inventing checkout truth");
    expect(
      document.querySelectorAll('[aria-label="Discount history records"] > li'),
    ).toHaveLength(3);
    expect(document.body.textContent).toContain("Launch archive");
    expect(document.body.textContent).toContain("Expired archive");
    expect(document.body.textContent).toContain("Capped archive");
    expect(button(/^All records\s*3$/u).getAttribute("aria-pressed")).toBe(
      "true",
    );

    click(button(/^Expired\s*1$/u));
    expect(button(/^Expired\s*1$/u).getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("Expired archive");
    expect(document.body.textContent).not.toContain("Launch archive");

    click(button("Reset"));
    const search = document.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    if (!search) throw new Error("Missing discount history search");
    setInput(search, "capped");
    await settle();
    expect(document.body.textContent).toContain("Capped archive");
    expect(document.body.textContent).not.toContain("Expired archive");

    setInput(search, "");
    const sort = document.querySelector<HTMLSelectElement>(".dhs-sort select");
    if (!sort) throw new Error("Missing discount history sort");
    setSelect(sort, "label");
    expect(sort.value).toBe("label");
    const labels = Array.from(
      document.querySelectorAll<HTMLElement>(".dhs-code .mono"),
    ).map((item) => item.textContent);
    expect(labels).toEqual([
      "Capped archive",
      "Expired archive",
      "Launch archive",
    ]);
  });

  it("opens a sanitized drawer and never exposes mutation or identity controls", async () => {
    mocks.listDiscounts.mockResolvedValueOnce({
      data: {
        items: [
          row({
            code: "LIVE-REDEEMABLE-SECRET",
            stripe_coupon_id: "provider-secret",
            tenant_id: "tenant-secret",
          }),
        ],
      },
    });
    mocks.listDiscountRedemptions.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: 9,
            redeemed_at: "2026-07-25T12:00:00.000Z",
            subscriber_linked: true,
            subscriber_id: "subscriber-secret",
            subscriber_email: "private@example.com",
            discount_code: "LIVE-REDEEMABLE-SECRET",
          },
        ],
      },
    });

    renderRoute();
    await settle();
    const opener = button("Inspect Launch archive");
    opener.focus();
    click(opener);
    await settle();

    const dialog = document.querySelector<HTMLElement>('aside[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.textContent).toContain("Launch archive");
    expect(dialog?.textContent).toContain("Subscriber-linked event");
    expect(mocks.listDiscountRedemptions).toHaveBeenCalledWith(OPEN_ID, {
      limit: 12,
    });

    const visibleText = document.body.textContent ?? "";
    for (const secret of [
      "LIVE-REDEEMABLE-SECRET",
      "provider-secret",
      "tenant-secret",
      "subscriber-secret",
      "private@example.com",
    ]) {
      expect(visibleText).not.toContain(secret);
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
      /\b(create|edit|duplicate|disable|redeem|validate|export)\b/iu,
    );
    const backdrop = document.querySelector<HTMLElement>(
      ".slideover-overlay-v2",
    );
    if (!backdrop) throw new Error("Missing discount history backdrop");
    act(() => {
      backdrop.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    await settle();
    expect(document.querySelector('aside[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("retains the last readable snapshot when refresh fails", async () => {
    renderRoute();
    await settle();
    mocks.listDiscounts.mockResolvedValueOnce({
      error: { message: "Archive gateway timed out." },
    });

    click(button("Refresh snapshot"));
    await settle();

    const alert = document.querySelector<HTMLElement>(
      ".dhs-retained-error[role='alert']",
    );
    expect(alert?.textContent).toContain(
      "Refresh failed; the last readable snapshot remains.",
    );
    expect(alert?.textContent).toContain("Archive gateway timed out.");
    expect(document.body.textContent).toContain("Launch archive");
    expect(
      document.querySelector('[aria-label="The archive could not be read."]'),
    ).toBeNull();
    expect(mocks.listDiscounts).toHaveBeenCalledTimes(2);
  });

  it("renders a terminal initial error and recovers through the same read path", async () => {
    mocks.listDiscounts
      .mockResolvedValueOnce({
        error: { message: "Archive service unavailable." },
      })
      .mockResolvedValueOnce({ data: { items: [row()] } });

    renderRoute();
    await settle();

    expect(document.body.textContent).toContain(
      "The archive could not be read.",
    );
    expect(document.body.textContent).toContain(
      "No historical data is being inferred.",
    );
    expect(document.body.textContent).not.toContain(
      "There are no discount records on file.",
    );

    click(button("Retry snapshot"));
    await settle();
    expect(document.body.textContent).toContain("Launch archive");
    expect(document.body.textContent).not.toContain(
      "The archive could not be read.",
    );
    expect(mocks.listDiscounts).toHaveBeenCalledTimes(2);
  });

  it("distinguishes a true empty archive from a filtered empty view", async () => {
    mocks.listDiscounts.mockResolvedValueOnce({ data: { items: [] } });
    renderRoute();
    await settle();

    expect(document.body.textContent).toContain(
      "There are no discount records on file.",
    );
    expect(document.body.textContent).toContain(
      "This is a truthful empty archive",
    );
    expect(document.body.textContent).not.toContain(
      "Nothing on file matches this view.",
    );

    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
    mocks.listDiscounts.mockResolvedValueOnce({
      data: { items: [row()] },
    });
    renderRoute();
    await settle();
    click(button(/^Data issues\s*0$/u));

    expect(document.body.textContent).toContain(
      "Nothing on file matches this view.",
    );
    expect(document.body.textContent).not.toContain(
      "There are no discount records on file.",
    );
    click(button("Reset filters"));
    expect(document.body.textContent).toContain("Launch archive");
  });

  it("keeps malformed evidence visible and routes integrity review through a filter", async () => {
    mocks.listDiscounts.mockResolvedValueOnce({
      data: {
        items: [
          row(),
          "rejected transport row",
          {
            id: "invalid-id",
            label: "",
            percent_off: 500,
            times_redeemed: -2,
            applies_to: "unknown",
          },
        ],
      },
    });

    renderRoute();
    await settle();

    const integrity = document.querySelector<HTMLElement>(
      ".dhs-integrity-banner[role='status']",
    );
    expect(integrity?.textContent).toContain(
      "1 readable record has field integrity warnings",
    );
    expect(integrity?.textContent).toContain("1 non-object row was rejected");
    click(button("Review data issues"));
    expect(document.body.textContent).toContain("Unidentified record 3");
    expect(document.body.textContent).not.toContain("Launch archive");
  });

  it("contains a recent-event failure to the open drawer and supports retry", async () => {
    mocks.listDiscounts.mockResolvedValueOnce({
      data: { items: [row()] },
    });
    mocks.listDiscountRedemptions
      .mockResolvedValueOnce({
        error: { message: "Ledger shard unavailable." },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              id: 12,
              redeemed_at: "2026-07-26T12:00:00.000Z",
              subscriber_linked: false,
            },
          ],
        },
      });

    renderRoute();
    await settle();
    click(button("Open details for Launch archive"));
    await settle();

    const alert = document.querySelector<HTMLElement>(
      ".dhs-inline-error[role='alert']",
    );
    expect(alert?.textContent).toContain("Recent events unavailable.");
    expect(alert?.textContent).toContain("Ledger shard unavailable.");
    expect(document.body.textContent).toContain("Launch archive");
    expect(document.body.textContent).toContain("What this row says");

    click(button("Retry"));
    await settle();
    expect(
      document.querySelector(".dhs-inline-error[role='alert']"),
    ).toBeNull();
    expect(document.body.textContent).toContain("Unattributed event");
    expect(mocks.listDiscountRedemptions).toHaveBeenCalledTimes(2);
  });

  it("paginates the archive without silently dropping the thirteenth record", async () => {
    const rows = Array.from({ length: 13 }, (_, index) =>
      row({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        label: `Archive ${String(index + 1).padStart(2, "0")}`,
        created_at: new Date(
          Date.parse("2026-07-01T00:00:00.000Z") + index * 60_000,
        ).toISOString(),
      }),
    );
    mocks.listDiscounts.mockResolvedValueOnce({ data: { items: rows } });

    renderRoute();
    await settle();
    expect(
      document.querySelectorAll('[aria-label="Discount history records"] > li'),
    ).toHaveLength(12);
    expect(document.body.textContent).toContain("Page 1 of 2");

    click(button("Next"));
    expect(document.body.textContent).toContain("Page 2 of 2");
    expect(
      document.querySelectorAll('[aria-label="Discount history records"] > li'),
    ).toHaveLength(1);
    expect(document.body.textContent).toContain("Archive 01");
  });

  it("has no serious or critical accessibility violations when populated or inspecting details", async () => {
    mocks.listDiscounts.mockResolvedValueOnce({
      data: { items: [row()] },
    });
    mocks.listDiscountRedemptions.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: 1,
            redeemed_at: "2026-07-25T12:00:00.000Z",
            subscriber_linked: true,
          },
        ],
      },
    });

    renderRoute();
    await settle();
    if (!container) throw new Error("Missing rendered route");
    expect(
      seriousOrCritical(
        await axe.run(container, { resultTypes: ["violations"] }),
      ),
    ).toEqual([]);

    click(button("Inspect Launch archive"));
    await settle();
    const dialog = document.querySelector<HTMLElement>('aside[role="dialog"]');
    if (!dialog) throw new Error("Missing discount history drawer");
    expect(
      seriousOrCritical(await axe.run(dialog, { resultTypes: ["violations"] })),
    ).toEqual([]);
  });
});
