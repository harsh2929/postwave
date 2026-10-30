// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// governance-92/94/95 on the consent-ledger register: cursor paging into
// older receipt/proof pages (with the family-consistency rules desktop
// enforces), retry after a failed older page, and the Review drawer reached
// from a loaded row. Every assertion is on a consequence: the exact request,
// the rows rendered, or the copy an operator reads.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: { signal?: AbortSignal }) => {
    return {} as unknown;
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: apiMock,
}));

import { ApiError } from "@/lib/api";
import type { ConsentLedger, ConsentReceipt } from "@/lib/consent-receipts-api";
import { ConsentEvidenceRegister } from "@/components/consent/ConsentEvidenceRegister";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT = "2026-09-01T10:00:00Z";
const CURSOR_1 = "eyJwYWdlIjoxfQ.c2lnbmF0dXJlLTE";
const CURSOR_2 = "eyJwYWdlIjoyfQ.c2lnbmF0dXJlLTI";

function receipt(over: Partial<ConsentReceipt>): ConsentReceipt {
  return {
    id: "1",
    subscriber_email: "ada@example.test",
    prev_state: "pending",
    new_state: "granted",
    source: "form",
    at: "2026-08-30T09:00:00Z",
    recorded_at: "2026-08-30T09:00:01Z",
    kind: "receipt",
    ...over,
  };
}

const PAGE_ONE: ConsentLedger = {
  schema_version: 1,
  workspace_id: WORKSPACE,
  snapshot_at: SNAPSHOT,
  source_planes: ["consent_receipts", "consent_records"],
  receipts: [
    receipt({ id: "30", subscriber_email: "newest@example.test" }),
    receipt({
      id: "20",
      subscriber_email: "middle@example.test",
      source: "api",
      recorded_at: "2026-08-29T09:00:00Z",
    }),
  ],
  count: 2,
  has_more: true,
  next_cursor: CURSOR_1,
};

function olderPage(over: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    workspace_id: WORKSPACE,
    snapshot_at: SNAPSHOT,
    source_planes: ["consent_receipts", "consent_records"],
    receipts: [
      receipt({
        id: "10",
        subscriber_email: "oldest@example.test",
        source: "csv_import",
        recorded_at: "2026-08-20T09:00:00Z",
        ip: "203.0.113.9",
      }),
    ],
    count: 1,
    has_more: false,
    ...over,
  };
}

let container: HTMLElement;
let root: Root;

async function mount(ledger: ConsentLedger) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ConsentEvidenceRegister, { ledger }),
      ),
    );
  });
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function button(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
  });
  await flush();
}

function paths(): string[] {
  return apiMock.get.mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  apiMock.get.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("ConsentEvidenceRegister cursor paging", () => {
  it("requests the older page by its signed cursor and appends it", async () => {
    apiMock.get.mockResolvedValueOnce(olderPage());
    await mount(PAGE_ONE);
    expect(container.textContent).toContain("2 of 2 loaded");
    expect(container.textContent).toContain(
      "2 rows loaded; older pages are available.",
    );

    await click(button("Load older receipts"));

    expect(paths()).toEqual([
      `/api/v1/consent/receipts?cursor=${CURSOR_1}&limit=200`,
    ]);
    expect(container.textContent).toContain("oldest@example.test");
    expect(container.textContent).toContain("3 of 3 loaded");
    expect(container.textContent).toContain(
      "End of the loaded receipt / proof page family (3 rows).",
    );
    expect(() => button("Load older receipts")).toThrow();
  });

  it("keeps loaded rows when the older page fails, shows the server sentence, and retries the same cursor", async () => {
    apiMock.get
      .mockRejectedValueOnce(
        new ApiError("Consent cursor signing is temporarily unavailable.", 503),
      )
      .mockResolvedValueOnce(olderPage());
    await mount(PAGE_ONE);

    await click(button("Load older receipts"));

    expect(container.textContent).toContain(
      "Could not verify the next receipt / proof page",
    );
    expect(container.textContent).toContain(
      "Consent cursor signing is temporarily unavailable.",
    );
    expect(container.textContent).toContain("Loaded evidence was kept.");
    expect(container.textContent).toContain("newest@example.test");
    expect(container.textContent).toContain("2 of 2 loaded");

    await click(button("Retry older page"));

    expect(paths()).toEqual([
      `/api/v1/consent/receipts?cursor=${CURSOR_1}&limit=200`,
      `/api/v1/consent/receipts?cursor=${CURSOR_1}&limit=200`,
    ]);
    expect(container.textContent).toContain("oldest@example.test");
    expect(container.textContent).not.toContain("Could not verify");
  });

  it.each([
    ["a drifted snapshot boundary", { snapshot_at: "2026-09-01T11:00:00Z" }],
    [
      "another workspace",
      { workspace_id: "33333333-3333-4333-8333-333333333333" },
    ],
    ["a repeated cursor", { has_more: true, next_cursor: CURSOR_1 }],
    [
      "a duplicate row identity",
      { receipts: [receipt({ id: "20", recorded_at: "2026-08-20T09:00:00Z" })] },
    ],
    [
      "rows newer than the loaded seam",
      {
        receipts: [
          receipt({
            id: "5",
            subscriber_email: "oldest@example.test",
            recorded_at: "2026-08-31T09:00:00Z",
          }),
        ],
      },
    ],
  ])("rejects an older page with %s and keeps the loaded family", async (_label, over) => {
    apiMock.get.mockResolvedValueOnce(olderPage(over));
    await mount(PAGE_ONE);

    await click(button("Load older receipts"));

    expect(container.textContent).toContain(
      "The server returned an inconsistent older receipt/proof page. Loaded evidence was kept; refresh from a new boundary before retrying.",
    );
    expect(container.textContent).not.toContain("oldest@example.test");
    expect(container.textContent).toContain("2 of 2 loaded");
  });

  it("keeps an already-appended older page when the next one fails", async () => {
    apiMock.get
      .mockResolvedValueOnce(
        olderPage({ has_more: true, next_cursor: CURSOR_2 }),
      )
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await mount(PAGE_ONE);

    await click(button("Load older receipts"));
    await click(button("Load older receipts"));

    expect(paths()).toEqual([
      `/api/v1/consent/receipts?cursor=${CURSOR_1}&limit=200`,
      `/api/v1/consent/receipts?cursor=${CURSOR_2}&limit=200`,
    ]);
    expect(container.textContent).toContain(
      "The older receipt/proof page could not be reached. Loaded evidence was kept.",
    );
    expect(container.textContent).toContain("oldest@example.test");
    expect(container.textContent).toContain("3 of 3 loaded");
  });

  it("follows the next cursor for a second older page", async () => {
    apiMock.get
      .mockResolvedValueOnce(
        olderPage({ has_more: true, next_cursor: CURSOR_2 }),
      )
      .mockResolvedValueOnce(
        olderPage({
          receipts: [
            receipt({
              id: "1",
              subscriber_email: "first@example.test",
              recorded_at: "2026-08-01T09:00:00Z",
            }),
          ],
        }),
      );
    await mount(PAGE_ONE);

    await click(button("Load older receipts"));
    await click(button("Load older receipts"));

    expect(paths()).toEqual([
      `/api/v1/consent/receipts?cursor=${CURSOR_1}&limit=200`,
      `/api/v1/consent/receipts?cursor=${CURSOR_2}&limit=200`,
    ]);
    expect(container.textContent).toContain("first@example.test");
    expect(container.textContent).toContain("4 of 4 loaded");
  });
});

describe("ConsentEvidenceRegister review + search", () => {
  it("opens the Review drawer for the row it was clicked on, including rows from older pages", async () => {
    apiMock.get.mockResolvedValueOnce(olderPage());
    await mount(PAGE_ONE);
    await click(button("Load older receipts"));

    const review = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Review state-change receipt for oldest@example.test"]',
    );
    expect(review).not.toBeNull();
    await click(review as HTMLButtonElement);

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("oldest@example.test");
    expect(dialog?.textContent).toContain("receipt:10");
    expect(
      dialog?.querySelector('pre[aria-label="Raw consent evidence JSON"]')
        ?.textContent,
    ).toContain('"ip": "203.0.113.9"');
  });

  it("narrows loaded rows by search and restores them with Reset view", async () => {
    await mount({ ...PAGE_ONE, has_more: false });
    const input = container.querySelector<HTMLInputElement>(
      'input[type="search"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, "middle");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(container.textContent).toContain("1 of 2 loaded");
    expect(container.textContent).not.toContain("newest@example.test");

    await click(button("Reset view"));
    expect(container.textContent).toContain("2 of 2 loaded");
    expect(input.value).toBe("");
    expect(apiMock.get).not.toHaveBeenCalled();
  });
});
