// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// SUB-037 destructive-safety behaviors of the Duplicates surface: role gating,
// stale-pair blocking, and — the load-bearing one — that a merge is NEVER
// applied without first previewing, and the apply uses the previewed
// plan_fingerprint (so the committed plan is exactly what was reviewed).
import { act, createElement } from "react";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "../_roots";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  listDuplicates: vi.fn(),
  listScanPairs: vi.fn(),
  previewMerge: vi.fn(),
  applyMerge: vi.fn(),
  selectedParam: null as string | null,
}));

vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoami,
  effectiveAuthRole: (me: { effective_role?: string; role?: string } | null) =>
    me?.effective_role ?? me?.role ?? null,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams(
      mocks.selectedParam ? { selected: mocks.selectedParam } : undefined,
    ),
}));

vi.mock("@/lib/subscriber-dedupe-api", () => ({
  listDuplicates: mocks.listDuplicates,
  listScanPairs: mocks.listScanPairs,
  previewMerge: mocks.previewMerge,
  applyMerge: mocks.applyMerge,
  parseSelectedDuplicatePairIds: (value: string | null) => {
    if (!value) return null;
    const ids = value.split(",");
    return ids.length === 2 ? ids : null;
  },
  duplicatePairMatchesSelection: (
    pair: { primary_id: string; duplicate_id: string },
    ids: readonly [string, string],
  ) =>
    (pair.primary_id === ids[0] && pair.duplicate_id === ids[1]) ||
    (pair.primary_id === ids[1] && pair.duplicate_id === ids[0]),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import DuplicatesPage from "@/app/(dashboard)/app/subscribers/duplicates/page";

afterEach(() => {
  unmountRoots();
  vi.clearAllMocks();
  mocks.selectedParam = null;
  document.body.innerHTML = "";
});

function pair(overrides: Record<string, unknown> = {}) {
  return {
    primary_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    primary_email: "jane@x.com",
    duplicate_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    duplicate_email: "jane+news@x.com",
    primary_updated_at: "2026-08-01T00:00:00Z",
    duplicate_updated_at: "2026-08-02T00:00:00Z",
    kind: "plus_alias",
    confidence: 0.8,
    evidence: [
      { kind: "plus_alias", confidence: 0.8, reason: "same base address" },
    ],
    stale: false,
    ...overrides,
  };
}

function scanPage(pairs: unknown[]) {
  return {
    scan: {
      scan_id: "11111111-1111-1111-1111-111111111111",
      status: "complete",
      subscriber_count: 1000,
      candidate_count: pairs.length,
      created_at: "2026-08-02T00:00:00Z",
      expires_at: "2026-08-03T00:00:00Z",
      complete: true,
    },
    pairs,
    count: pairs.length,
    complete: true,
  };
}

function render(ui: ReactNode): Root {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = trackRoot(container);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((r) => window.requestAnimationFrame(r));
  await new Promise((r) => window.setTimeout(r, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 25; i += 1) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await flush();
    }
  }
  throw lastError;
}

function reviewButton(): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Review & merge"),
  ) as HTMLButtonElement | undefined;
}

describe("SUB-037 duplicates surface", () => {
  it("resolves a two-id handoff through the complete tenant scan and withholds unrelated pairs", async () => {
    const selectedPrimary = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const selectedDuplicate = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mocks.selectedParam = `${selectedPrimary},${selectedDuplicate}`;
    mocks.whoami.mockResolvedValue({
      tenant_id: "t1",
      user_id: "u1",
      role: "editor",
    });
    const firstPage = scanPage([
      pair({
        primary_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        duplicate_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        primary_email: "unrelated@example.com",
      }),
    ]);
    firstPage.scan.candidate_count = 2;
    Object.assign(firstPage, { next_cursor: "1" });
    mocks.listDuplicates.mockResolvedValue(firstPage);
    mocks.listScanPairs.mockResolvedValue({
      ...scanPage([
        pair({
          primary_id: selectedPrimary,
          duplicate_id: selectedDuplicate,
          primary_email: "selected@example.com",
        }),
      ]),
      scan: firstPage.scan,
    });

    render(createElement(DuplicatesPage));
    await waitFor(() => {
      if (!document.body.textContent?.includes("selected@example.com")) {
        throw new Error("selected pair not resolved");
      }
    });

    expect(document.body.textContent).not.toContain("unrelated@example.com");
    expect(mocks.listScanPairs).toHaveBeenCalledWith(
      firstPage.scan.scan_id,
      expect.objectContaining({ cursor: "1", signal: expect.any(AbortSignal) }),
    );
  });

  it("returns focus to the reviewed pair when the merge dialog is cancelled", async () => {
    mocks.whoami.mockResolvedValue({ tenant_id: "t1", role: "editor" });
    mocks.listDuplicates.mockResolvedValue(scanPage([pair()]));
    mocks.previewMerge.mockReturnValue(new Promise(() => undefined));
    const root = render(createElement(DuplicatesPage));
    try {
      await waitFor(() => {
        if (!reviewButton()) throw new Error("no review button yet");
      });
      const trigger = reviewButton();
      act(() => trigger?.click());
      await waitFor(() => {
        if (!document.querySelector('[role="dialog"]')) {
          throw new Error("merge dialog did not open");
        }
      });
      const cancel = [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Cancel",
      );
      cancel?.focus();
      await act(async () => {
        cancel?.click();
        await flush();
      });

      expect(document.activeElement).toBe(trigger);
    } finally {
      act(() => root.unmount());
    }
  });

  it("an editor can review a fresh pair; the evidence + confidence show", async () => {
    mocks.whoami.mockResolvedValue({ tenant_id: "t1", role: "editor" });
    mocks.listDuplicates.mockResolvedValue(scanPage([pair()]));
    render(createElement(DuplicatesPage));
    await waitFor(() => {
      if (!document.body.textContent?.includes("jane@x.com"))
        throw new Error("pair not rendered");
    });
    expect(document.body.textContent).toContain("80% match");
    expect(document.body.textContent).toContain("same base address");
    const confidence = [...document.body.querySelectorAll("span")].find(
      (node) => node.textContent === "80% match",
    );
    expect(confidence?.className).toContain("text-amber-800");
    expect(confidence?.className).not.toContain("text-amber-700");
    const btn = reviewButton();
    expect(btn).toBeTruthy();
    expect(btn?.disabled).toBe(false);
  });

  it("a viewer cannot merge: the button is disabled and the note explains why", async () => {
    mocks.whoami.mockResolvedValue({ tenant_id: "t1", role: "viewer" });
    mocks.listDuplicates.mockResolvedValue(scanPage([pair()]));
    render(createElement(DuplicatesPage));
    await waitFor(() => {
      if (!reviewButton()) throw new Error("no button yet");
    });
    expect(reviewButton()?.disabled).toBe(true);
    expect(document.body.textContent).toContain("requires an editor role");
  });

  it("a stale pair is blocked before the click (guaranteed to fail merge)", async () => {
    mocks.whoami.mockResolvedValue({ tenant_id: "t1", role: "editor" });
    mocks.listDuplicates.mockResolvedValue(scanPage([pair({ stale: true })]));
    render(createElement(DuplicatesPage));
    await waitFor(() => {
      if (!reviewButton()) throw new Error("no button yet");
    });
    expect(reviewButton()?.disabled).toBe(true);
    expect(document.body.textContent).toContain("re-scan to refresh");
  });

  it("shows the SERVER's kept/discarded values and re-previews on swap (no client inversion)", async () => {
    mocks.whoami.mockResolvedValue({ tenant_id: "t1", role: "editor" });
    mocks.listDuplicates.mockResolvedValue(scanPage([pair()]));
    // The server orients the plan to the request's primary (= survivor). Before
    // swap, primary (jane@x.com) survives → keep "pro". After swap the request
    // primary is the other record → the server returns keep "free".
    const planFor = (keep: string, discard: string) => ({
      primary_id: "x",
      duplicate_id: "y",
      dry_run: true,
      plan: {
        tags: [],
        custom_fields: {},
        status: "enabled",
        gdpr_permissions: [],
        conflicts: [
          {
            field: "custom_fields.plan",
            primary_value: keep,
            duplicate_value: discard,
            resolution: "primary_wins",
          },
        ],
        preserved_on_duplicate: [],
      },
      events_moved: 0,
      suppressions_moved: 0,
      loser_soft_deleted: true,
      primary_updated_at: "2026-08-01T00:00:00Z",
      duplicate_updated_at: "2026-08-02T00:00:00Z",
      plan_fingerprint: "FP",
    });
    mocks.previewMerge
      .mockResolvedValueOnce(planFor("pro", "free"))
      .mockResolvedValueOnce(planFor("free", "pro"));

    render(createElement(DuplicatesPage));
    await waitFor(() => {
      if (!reviewButton()) throw new Error("no button");
    });
    act(() => reviewButton()!.click());
    await waitFor(() => {
      if (!document.body.textContent?.includes("custom_fields.plan"))
        throw new Error("conflict not shown");
    });
    // Before swap: keep pro, discard free.
    expect(document.body.textContent).toContain("keep pro");
    expect(document.body.textContent).toContain("discard free");

    const swapBtn = [...document.body.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("instead"),
    ) as HTMLButtonElement | undefined;
    expect(swapBtn).toBeTruthy();
    act(() => swapBtn!.click());

    // After swap the second preview is used; the display trusts the server
    // (keep free), NOT a client-side inversion of the first plan (which would
    // show keep pro).
    await waitFor(() => {
      if (mocks.previewMerge.mock.calls.length < 2)
        throw new Error("swap did not re-preview");
    });
    await waitFor(() => {
      if (!document.body.textContent?.includes("keep free"))
        throw new Error("post-swap value not updated");
    });
    expect(document.body.textContent).toContain("keep free");
    expect(document.body.textContent).toContain("discard pro");
  });

  it("NEVER applies without previewing first, and applies the previewed fingerprint", async () => {
    mocks.whoami.mockResolvedValue({ tenant_id: "t1", role: "editor" });
    mocks.listDuplicates.mockResolvedValue(scanPage([pair()]));
    mocks.previewMerge.mockResolvedValue({
      primary_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      duplicate_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      dry_run: true,
      plan: {
        tags: [],
        custom_fields: {},
        status: "enabled",
        gdpr_permissions: [],
        conflicts: [],
        preserved_on_duplicate: [],
      },
      events_moved: 3,
      suppressions_moved: 0,
      loser_soft_deleted: true,
      primary_updated_at: "2026-08-01T00:00:00Z",
      duplicate_updated_at: "2026-08-02T00:00:00Z",
      plan_fingerprint: "FP-XYZ",
    });
    mocks.applyMerge.mockResolvedValue({ dry_run: false });

    render(createElement(DuplicatesPage));
    await waitFor(() => {
      if (!reviewButton()) throw new Error("no button yet");
    });
    act(() => reviewButton()!.click());

    // Opening the dialog triggers the dry-run preview — never an apply.
    await waitFor(() => {
      if (mocks.previewMerge.mock.calls.length === 0)
        throw new Error("preview not called");
    });
    expect(mocks.applyMerge).not.toHaveBeenCalled();

    // The irreversible warning + the merge button are shown after the preview.
    await waitFor(() => {
      if (!document.body.textContent?.includes("cannot be undone"))
        throw new Error("warning not shown");
    });
    const cancelBtn = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Cancel",
    );
    expect(cancelBtn).toBeTruthy();
    const mergeBtn = [...document.body.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Merge permanently"),
    ) as HTMLButtonElement | undefined;
    expect(mergeBtn).toBeTruthy();
    const confirmation = document.querySelector<HTMLInputElement>(
      'input[id^="merge-confirm-"]',
    );
    if (!confirmation) throw new Error("missing typed merge confirmation");
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(confirmation, "jane+news@x.com");
      confirmation.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(mergeBtn?.disabled).toBe(false);
    act(() => mergeBtn!.click());

    await waitFor(() => {
      if (mocks.applyMerge.mock.calls.length === 0)
        throw new Error("apply not called");
    });
    // Applied with the exact fingerprint the preview returned.
    expect(mocks.applyMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      }),
      "FP-XYZ",
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^subscriber-merge:/),
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
