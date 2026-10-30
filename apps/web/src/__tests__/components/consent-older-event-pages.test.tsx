// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// governance-92 on the consent-event ledger: "Load older events" follows the
// signed cursor, appends only rows after page one, rejects a drifted page, and
// "Retry older page" re-requests the same cursor without dropping rows.

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
import type { ConsentEvent, ConsentLedger } from "@/lib/consent-evidence-api";
import { ConsentOlderEventPages } from "@/components/consent/ConsentOlderEventPages";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT = "2026-09-01T10:00:00Z";
const CURSOR = "eyJldmVudHMiOjF9.ZXZlbnQtc2ln";

function event(over: Partial<ConsentEvent>): ConsentEvent {
  return {
    id: "e-30",
    subject_type: "subscriber",
    subject_id: "s-1",
    subject_email: "page.one@example.test",
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
  };
}

const PAGE_ONE: ConsentLedger = {
  events: [event({})],
  count: 1,
  source_planes: ["consent_events"],
  snapshot_at: SNAPSHOT,
  has_more: true,
  schema_version: 1,
  workspace_id: WORKSPACE,
  next_cursor: CURSOR,
};

function olderWire(over: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    workspace_id: WORKSPACE,
    snapshot_at: SNAPSHOT,
    source_planes: ["consent_events"],
    events: [
      event({
        id: "e-10",
        subject_email: "older.subject@example.test",
        created_at: "2026-08-01T10:00:00Z",
        recorded_at: "2026-08-21T10:00:00Z",
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
        createElement(ConsentOlderEventPages, { ledger }),
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
    ...container.querySelectorAll<HTMLButtonElement>("button"),
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

beforeEach(() => apiMock.get.mockReset());

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("ConsentOlderEventPages", () => {
  it("renders nothing of page one and loads the older page by cursor", async () => {
    apiMock.get.mockResolvedValueOnce(olderWire());
    await mount(PAGE_ONE);
    expect(container.textContent).not.toContain("page.one@example.test");
    expect(container.textContent).toContain(
      "1 row loaded; older pages are available.",
    );

    await click(button("Load older events"));

    expect(apiMock.get.mock.calls.map((call) => call[0])).toEqual([
      `/api/v1/consent/events?cursor=${CURSOR}&limit=200`,
    ]);
    const older = container.querySelector('[aria-label="Older consent events"]');
    expect(older?.textContent).toContain("older.subject@example.test");
    expect(older?.textContent).toContain("20 days later");
    expect(older?.textContent).not.toContain("page.one@example.test");
    expect(container.textContent).toContain(
      "End of the loaded consent-event page family (2 rows).",
    );
  });

  it("keeps the loaded family on a transport failure and retries the same cursor", async () => {
    apiMock.get
      .mockRejectedValueOnce(new ApiError("Admin scope is required.", 403))
      .mockResolvedValueOnce(olderWire());
    await mount(PAGE_ONE);

    await click(button("Load older events"));
    expect(container.textContent).toContain(
      "Could not verify the next consent event page",
    );
    expect(container.textContent).toContain("Admin scope is required.");
    expect(container.textContent).toContain(
      "Loaded correlation evidence was kept.",
    );

    await click(button("Retry older page"));
    expect(apiMock.get.mock.calls.map((call) => call[0])).toEqual([
      `/api/v1/consent/events?cursor=${CURSOR}&limit=200`,
      `/api/v1/consent/events?cursor=${CURSOR}&limit=200`,
    ]);
    expect(container.textContent).toContain("older.subject@example.test");
  });

  it("rejects an older page from a different snapshot boundary", async () => {
    apiMock.get.mockResolvedValueOnce(
      olderWire({ snapshot_at: "2026-09-02T10:00:00Z" }),
    );
    await mount(PAGE_ONE);

    await click(button("Load older events"));

    expect(container.textContent).toContain(
      "The server returned an inconsistent older event page.",
    );
    expect(container.textContent).not.toContain("older.subject@example.test");
  });

  it("never sends a malformed cursor to the server", async () => {
    await mount({ ...PAGE_ONE, next_cursor: undefined });
    expect(() => button("Load older events")).toThrow();
    expect(container.textContent).toContain(
      "returned no continuation cursor",
    );
    expect(apiMock.get).not.toHaveBeenCalled();
  });
});
