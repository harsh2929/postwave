// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SegmentsList } from "@/app/(dashboard)/app/subscribers/segments/segments-list";
import type { Segment } from "@/lib/segments-api";

import { renderPage, stubFixtureTransport, unmount } from "../pages/_harness";
import { importBeforeTests, waitFor } from "../pages/_wait";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  whoami: vi.fn(),
  listSegments: vi.fn(),
  listSegmentFolders: vi.fn(),
  recomputeSegment: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: mocks.replace,
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/subscribers/segments",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
  },
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/segments-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/segments-api")>()),
  listSegments: mocks.listSegments,
  listSegmentFolders: mocks.listSegmentFolders,
  recomputeSegment: mocks.recomputeSegment,
}));

vi.mock("@/components/segments/ai-suggestions-panel", () => ({
  AiSuggestionsPanel: () => null,
}));

vi.mock("@/components/mailchimp-parity/audience-intelligence-panel", () => ({
  AudienceIntelligencePanel: () => null,
}));

const SEGMENT: Segment = {
  id: "segment-bulk-race",
  tenantId: "tenant-demo",
  name: "Bulk action race segment",
  description: "A deterministic audience.",
  queryAst: { op: "and", children: [] },
  lastCount: 42,
  lastEvaluatedAt: "2026-08-25T09:00:00Z",
  createdAt: "2026-08-20T09:00:00Z",
  updatedAt: "2026-08-25T09:00:00Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function exactButton(text: string, scope: ParentNode = document) {
  const button = Array.from(scope.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function desktopRowCheckbox(container: HTMLElement) {
  const checkbox = container.querySelector<HTMLInputElement>(
    `table input[aria-label="Select ${SEGMENT.name}"]`,
  );
  if (!checkbox) throw new Error("Desktop segment checkbox not found");
  return checkbox;
}

beforeEach(() => {
  stubFixtureTransport();
  mocks.whoami.mockResolvedValue({
    user_id: "user-demo",
    tenant_id: "tenant-demo",
    email: "owner@postwave.test",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
  });
  mocks.listSegments.mockResolvedValue([SEGMENT]);
  mocks.listSegmentFolders.mockResolvedValue([]);
  mocks.recomputeSegment.mockResolvedValue({
    count: 51,
    scheduled_at: "2026-08-25T10:00:00Z",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

// Warm the lazily loaded confirmation so the test does not pay the cold
// import on its own clock.
importBeforeTests(() => import("@/components/ui/confirm-dialog"));

describe("segment bulk-action selection ownership", () => {
  it("does not let a late recalculation clear a newer bulk-delete selection", async () => {
    const gate = deferred<{ count: number; scheduled_at: string }>();
    mocks.recomputeSegment.mockReturnValueOnce(gate.promise);
    const { container, root } = await renderPage(SegmentsList, {
      initialSegments: [SEGMENT],
    });

    try {
      const checkbox = desktopRowCheckbox(container);
      await act(async () => checkbox.click());
      expect(checkbox.checked).toBe(true);

      await act(async () => exactButton("Recalculate", container).click());
      expect(mocks.recomputeSegment).toHaveBeenCalledTimes(1);
      // The action consumes its snapshot synchronously. A later user choice is
      // therefore a new selection, not state the pending request may erase.
      expect(checkbox.checked).toBe(false);
      expect(container.textContent).not.toContain("1 selected");

      await act(async () => checkbox.click());
      expect(checkbox.checked).toBe(true);
      const bulkActions = container.querySelector<HTMLElement>(
        '[role="group"][aria-label="Bulk segment actions"]',
      );
      if (!bulkActions) throw new Error("Bulk segment actions not found");
      const deleteTrigger = exactButton("Delete", bulkActions);
      await act(async () => deleteTrigger.click());
      // The confirmation loads on its first open (DeferredConfirmDialog).
      await waitFor(() =>
        expect(
          document.querySelector('[role="dialog"]')?.textContent,
        ).toContain("Delete 1 segment?"),
      );

      await act(async () => {
        gate.resolve({
          count: 51,
          scheduled_at: "2026-08-25T10:00:00Z",
        });
        await gate.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(checkbox.checked).toBe(true);
      expect(deleteTrigger.isConnected).toBe(true);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      const openDialog = document.querySelector<HTMLElement>('[role="dialog"]');
      if (!openDialog) throw new Error("Bulk delete dialog not found");
      await act(async () => {
        exactButton("Cancel", openDialog).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(deleteTrigger.isConnected).toBe(true);
      expect(document.activeElement).toBe(deleteTrigger);

      await act(async () => deleteTrigger.click());
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        "Delete 1 segment?",
      );
    } finally {
      unmount(root);
    }
  });
});
