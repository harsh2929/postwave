// @vitest-environment happy-dom

import axe from "axe-core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  ConsentEvent,
  ConsentEventsResponse,
  ConsentReceipt,
  ConsentReceiptsResponse,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  listConsentEvents: vi.fn(),
  listConsentReceipts: vi.fn(),
  me: {
    user: "11111111-1111-4111-8111-111111111111",
    tenant: "22222222-2222-4222-8222-222222222222",
    role: "admin" as const,
    effectiveRole: "admin" as const,
  },
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listConsentEvents: mocks.listConsentEvents,
    listConsentReceipts: mocks.listConsentReceipts,
  },
}));

vi.mock("../../lib/store", () => ({
  useMe: () => mocks.me,
}));

import { DESKTOP_CAPABILITIES } from "../../lib/desktop-capabilities";
import { requestDesktopRouteNavigation } from "../../lib/desktop-router";
import { Consent } from "../../pages/Consent";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const WORKSPACE_ID = mocks.me.tenant;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let dateNow: ReturnType<typeof vi.spyOn> | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  mocks.listConsentEvents.mockReset();
  mocks.listConsentReceipts.mockReset();
  dateNow = vi.spyOn(Date, "now").mockReturnValue(NOW);
  mocks.listConsentEvents.mockResolvedValue({ data: eventPage([]) });
  mocks.listConsentReceipts.mockResolvedValue({ data: receiptPage([]) });
  await act(async () => {
    await requestDesktopRouteNavigation(
      { section: "consent" },
      { replace: true, source: "navigation" },
    );
  });
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => {
      mounted.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  dateNow?.mockRestore();
  dateNow = null;
});

function receipt(
  id: string,
  recordedAt: string,
  overrides: Partial<ConsentReceipt> = {},
): ConsentReceipt {
  return {
    id,
    kind: "receipt",
    subscriber_email: `person-${id}@example.test`,
    prev_state: "unconfirmed",
    new_state: "subscribed",
    source: "form:newsletter",
    source_detail: "Footer form",
    privacy_policy_version: "2026-08",
    captured_text: "I agree",
    at: recordedAt,
    recorded_at: recordedAt,
    ...overrides,
  };
}

function receiptPage(
  receipts: ConsentReceipt[],
  overrides: Partial<ConsentReceiptsResponse> = {},
): ConsentReceiptsResponse {
  return {
    schema_version: 1,
    workspace_id: WORKSPACE_ID,
    snapshot_at: "2026-08-20T12:00:00.000000Z",
    source_planes: ["consent_receipts", "consent_records"],
    receipts,
    count: receipts.length,
    has_more: false,
    ...overrides,
  };
}

function consentEvent(
  id: string,
  category: ConsentEvent["category"],
  overrides: Partial<ConsentEvent> = {},
): ConsentEvent {
  return {
    id,
    decision_id: "44444444-4444-4444-8444-444444444444",
    subject_type: "subscriber",
    subject_id: "55555555-5555-4555-8555-555555555555",
    subject_email: "gpc-person@example.test",
    channel: "web",
    category,
    action: "denied",
    source: "gpc",
    policy_version: "2026-08",
    preferences: { gpc: true },
    created_at: "2026-08-19T10:00:00.000000Z",
    recorded_at: "2026-08-19T10:00:01.000000Z",
    ...overrides,
  };
}

function eventPage(
  events: ConsentEvent[],
  overrides: Partial<ConsentEventsResponse> = {},
): ConsentEventsResponse {
  return {
    schema_version: 1,
    workspace_id: WORKSPACE_ID,
    snapshot_at: "2026-08-20T12:00:00.000000Z",
    source_planes: ["consent_events"],
    events,
    count: events.length,
    has_more: false,
    ...overrides,
  };
}

function render(node: ReactElement = <Consent />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function statValue(label: string): string {
  const cell = Array.from(
    document.querySelectorAll<HTMLElement>(".stat-strip-v2-cell"),
  ).find(
    (candidate) =>
      candidate.querySelector(".stat-strip-v2-label")?.textContent === label,
  );
  if (!cell) throw new Error(`Missing statistic: ${label}`);
  return cell.querySelector(".stat-strip-v2-value")?.textContent?.trim() ?? "";
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

describe("Consent evidence command center maturity", () => {
  it("is structurally limited to an admin-only, read-only inspection entry", () => {
    const capability = DESKTOP_CAPABILITIES.consent;
    expect(capability.readiness).toBe("read-only");
    expect(capability.entryRole).toBe("admin");
    expect(capability.limitation).toContain("bounded receipt/proof");
    expect(capability.limitation).toContain("does not prove complete");
  });

  it("keeps local page navigation stable after remote rows have settled", async () => {
    const rows = Array.from({ length: 51 }, (_, index) => {
      const recordedAt = new Date(NOW - (index + 1) * 60_000).toISOString();
      return receipt(String(10_000 - index), recordedAt);
    });
    mocks.listConsentReceipts.mockResolvedValue({ data: receiptPage(rows) });

    render();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Page 1 of 2");
    });

    act(() =>
      buttonByLabel("Next page of loaded receipt and proof evidence").click(),
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("Page 2 of 2");
      expect(document.body.textContent).toContain("person-9950@example.test");
    });
    await act(async () => Promise.resolve());
    expect(document.body.textContent).toContain("Page 2 of 2");
  });

  it("deduplicates GPC subjects, excludes future occurrences, and exposes no clipboard or export action", async () => {
    const past = receipt("42", "2026-08-19T09:00:01.000000Z", {
      subscriber_email: "past@example.test",
    });
    const future = receipt("41", "2026-08-21T09:00:01.000000Z", {
      subscriber_email: "future@example.test",
    });
    mocks.listConsentReceipts.mockResolvedValue({
      data: receiptPage([future, past]),
    });
    mocks.listConsentEvents.mockResolvedValue({
      data: eventPage([
        consentEvent(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
          "targeted_advertising",
          { recorded_at: "2026-08-19T10:00:03.000000Z" },
        ),
        consentEvent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "sale_share", {
          recorded_at: "2026-08-19T10:00:02.000000Z",
        }),
        consentEvent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "analytics", {
          recorded_at: "2026-08-19T10:00:01.000000Z",
        }),
        consentEvent("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "marketing", {
          decision_id: undefined,
          subject_id: undefined,
          subject_email: undefined,
          recorded_at: "2026-08-19T10:00:00.000000Z",
        }),
      ]),
    });

    render();
    await waitFor(() => {
      expect(statValue("Loaded opt-ins · 30d")).toBe("1");
      expect(statValue("Known GPC subjects · 30d")).toBe("1");
    });

    expect(document.body.textContent).toContain(
      "1 loaded 30-day GPC-tagged row has no stable subject ID or email",
    );
    expect(document.body.textContent).toContain(
      "1 loaded occurrence timestamp is later than this device's current time",
    );
    expect(document.body.textContent).toContain("Evidence boundaries");
    expect(document.body.textContent).toContain(
      "This page intentionally has no export or mutation action.",
    );
    expect(
      Array.from(document.querySelectorAll("button")).some((button) =>
        /export|copy/iu.test(button.textContent ?? ""),
      ),
    ).toBe(false);

    act(() =>
      buttonByLabel(
        "Review state-change receipt for past@example.test",
      ).click(),
    );
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Sensitive personal data");
    expect(dialog.querySelector("details")?.open).toBe(false);
    expect(
      Array.from(dialog.querySelectorAll("button")).some((button) =>
        /copy/iu.test(button.textContent ?? ""),
      ),
    ).toBe(false);

    const source = readFileSync(
      resolve(process.cwd(), "src/pages/Consent.tsx"),
      "utf8",
    );
    expect(source).not.toContain("writeClipboardText");
    expect(source).not.toContain("navigator.clipboard");

    const result = await axe.run(container!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("appends only an identity-matched older page within the same boundary", async () => {
    const newer = receipt("100", "2026-08-20T09:00:00.000002Z");
    const older = receipt("99", "2026-08-20T09:00:00.000001Z");
    mocks.listConsentReceipts
      .mockResolvedValueOnce({
        data: receiptPage([newer], {
          has_more: true,
          next_cursor: "receipt-page-2",
        }),
      })
      .mockResolvedValueOnce({ data: receiptPage([older]) });

    render();
    await waitFor(() => {
      expect(document.body.textContent).toContain("1 loaded");
    });
    const loadMore = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Load more");
    if (!loadMore) throw new Error("Missing receipt Load more action");
    act(() => loadMore.click());

    await waitFor(() => {
      expect(mocks.listConsentReceipts).toHaveBeenLastCalledWith({
        workspaceId: WORKSPACE_ID,
        limit: 200,
        cursor: "receipt-page-2",
      });
      expect(document.body.textContent).toContain("2 loaded");
      expect(document.body.textContent).toContain("person-99@example.test");
    });
  });
});
