// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Deleting a segment that campaigns which haven't sent yet still use. The API
// answers 409 segment_in_use naming them (recorded from the Go handler in
// fixtures/segments/segment-delete-409.json). It used to answer 500 "an
// internal error occurred", which the client retried twice more. The list must
// show the server's reason, keep the row, and send the request once; the bulk
// delete must say why the kept ones were kept.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SegmentsList } from "@/app/(dashboard)/app/subscribers/segments/segments-list";
import type { Segment } from "@/lib/segments-api";

import refusal from "../fixtures/segments/segment-delete-409.json";
import created from "../fixtures/segments/segment-create-201.json";
import { renderPage, unmount } from "../pages/_harness";
import { importBeforeTests, waitFor } from "../pages/_wait";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
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
    message: vi.fn(),
  },
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/components/segments/ai-suggestions-panel", () => ({
  AiSuggestionsPanel: () => null,
}));
vi.mock("@/components/mailchimp-parity/audience-intelligence-panel", () => ({
  AudienceIntelligencePanel: () => null,
}));

const IN_USE: Segment = {
  ...(created as Segment),
  name: "Spring audience",
};
const FREE: Segment = {
  ...(created as Segment),
  id: "0b8a4f5e-2c1d-4e3f-9a8b-7c6d5e4f3a21",
  name: "Old test audience",
};

const deletes: string[] = [];

beforeEach(() => {
  deletes.length = 0;
  mocks.whoami.mockResolvedValue({
    user_id: "11111111-1111-4111-8111-111111111111",
    tenant_id: IN_USE.tenantId,
    email: "owner@example.test",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
        "http://localhost",
      );
      const method = (init?.method ?? "GET").toUpperCase();
      const reply = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (method === "DELETE" && url.pathname.startsWith("/api/v1/segments/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        deletes.push(id);
        return id === IN_USE.id ? reply(refusal, 409) : reply({ ok: true });
      }
      if (url.pathname === "/api/v1/segments") return reply([IN_USE, FREE]);
      if (url.pathname === "/api/v1/segment-folders")
        return reply({ items: [] });
      return reply({ error: { code: "not_found", message: "" } }, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function exactButton(text: string, scope: ParentNode = document) {
  const button = Array.from(scope.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The confirmations load on first open (DeferredConfirmDialog); warm their
// module so no test pays the cold import on its own clock.
importBeforeTests(() => import("@/components/ui/confirm-dialog"));

describe("deleting a segment campaigns still use", () => {
  it("shows the server's reason, keeps the row, and asks once", async () => {
    const { container, root } = await renderPage(SegmentsList, {
      initialSegments: [IN_USE, FREE],
    });
    try {
      const trigger = container.querySelector<HTMLButtonElement>(
        `button[aria-label="More actions for ${IN_USE.name}"]`,
      );
      if (!trigger) throw new Error("row menu trigger not found");
      await act(async () => trigger.click());
      const menu = document.querySelector('[role="menu"]');
      await act(async () => exactButton("Delete", menu!).click());
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
      );
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog?.textContent).toContain(
        "If a campaign that hasn't started sending uses it as its audience, the delete is refused",
      );
      await act(async () => {
        exactButton("Delete", dialog!).click();
      });
      await settle();

      expect(mocks.toastError).toHaveBeenCalledWith(refusal.error.message);
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      expect(deletes).toEqual([IN_USE.id]);
      expect(container.textContent).toContain(IN_USE.name);
    } finally {
      unmount(root);
    }
  });

  it("bulk delete removes what it can and says why the rest stayed", async () => {
    const { container, root } = await renderPage(SegmentsList, {
      initialSegments: [IN_USE, FREE],
    });
    try {
      for (const seg of [IN_USE, FREE]) {
        const box = container.querySelector<HTMLInputElement>(
          `table input[aria-label="Select ${seg.name}"]`,
        );
        await act(async () => box!.click());
      }
      const bulk = container.querySelector<HTMLElement>(
        '[role="group"][aria-label="Bulk segment actions"]',
      );
      await act(async () => exactButton("Delete", bulk!).click());
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
      );
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog?.textContent).toContain(
        "A segment that is the audience of a campaign that hasn't started sending is kept",
      );
      await act(async () => exactButton("Delete", dialog!).click());
      await settle();

      expect(deletes.sort()).toEqual([FREE.id, IN_USE.id].sort());
      expect(mocks.toastWarning).toHaveBeenCalledWith(
        "Deleted 1 of 2. 1 segment was kept and is still selected.",
        { description: `"${IN_USE.name}": ${refusal.error.message}` },
      );
      expect(container.textContent).toContain(IN_USE.name);
      expect(container.textContent).not.toContain(FREE.name);
    } finally {
      unmount(root);
    }
  });
});
