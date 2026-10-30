// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// What the directory's bulk actions SAY they did.
//
// "Deleted 1 contacts." and "Added to list 3 contacts." were the receipts for
// two of the most destructive verbs in the product: the first cannot count, the
// second names no list and reads backwards. Both are asserted here through the
// real page over a stubbed transport, because a count phrase is only wrong in
// the rendered sentence.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", async () =>
  (await import("../helpers/subscriber-directory-harness")).navigationMock(),
);
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const { WHOAMI } = await import("./_harness");
  return {
    ...(await importOriginal<typeof import("@/lib/auth-api")>()),
    whoami: vi.fn().mockResolvedValue(WHOAMI),
    whoamiFresh: vi.fn().mockResolvedValue(WHOAMI),
  };
});
vi.mock("@/lib/realtime/event-bus-client", () => ({
  connectRealtimeBus: () => () => undefined,
}));
const toasts = vi.hoisted(() => [] as { level: string; text: string }[]);
vi.mock("sonner", () => {
  const record = (level: string) => (message: unknown) => {
    toasts.push({ level, text: String(message) });
    return "toast-id";
  };
  return {
    toast: Object.assign(record("message"), {
      error: record("error"),
      success: record("success"),
      warning: record("warning"),
      message: record("message"),
    }),
  };
});

import { renderPage, unmount } from "./_harness";
import {
  button,
  click,
  navStore,
  type,
} from "../helpers/subscriber-directory-harness";

const ADA = "11111111-2222-4333-8444-555555555555";
const ADA_EMAIL = "ada@example.com";
const NEWSLETTER = 42;

const posted: { path: string; body: unknown }[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function directoryPage() {
  return {
    items: [
      {
        id: ADA,
        email: ADA_EMAIL,
        status: "enabled",
        custom_fields: {},
        tags: [],
        consent_source: "api",
        consent_timestamp: "2026-09-01T00:00:00Z",
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:00:00Z",
      },
    ],
    total: 1,
    page: 1,
    per_page: 50,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 14; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  posted.length = 0;
  toasts.length = 0;
  navStore.reset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const url = new URL(raw, "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
      if (method === "POST") posted.push({ path: url.pathname, body });
      if (url.pathname === "/api/v1/subscribers" && method === "GET") {
        return json(directoryPage());
      }
      if (url.pathname === "/api/v1/subscribers/search") return json(directoryPage());
      if (url.pathname === "/api/v1/lists" && method === "GET") {
        return json({ data: { results: [{ id: NEWSLETTER, name: "Newsletter", subscriber_count: 3 }] } });
      }
      if (url.pathname === "/api/v1/subscribers/bulk/add-to-list") {
        return json({ affected: 1, source: "ids", skipped: 0 });
      }
      if (url.pathname === "/api/v1/subscribers/bulk/delete") {
        return json({ affected: 1, source: "ids", skipped: 0 });
      }
      return json({ error: { code: "not_found", message: "" } }, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function mountDirectory() {
  const Page = (await import("@/app/(dashboard)/app/subscribers/page")).default;
  const rendered = await renderPage(Page);
  await settle();
  return rendered;
}

/** Selects the one row, which is what reveals the bulk toolbar. */
function selectAda(container: HTMLElement): void {
  const checkbox = [...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].find(
    (input) => input.getAttribute("aria-label") === `Select ${ADA_EMAIL}`,
  );
  if (!checkbox) throw new Error("the row's selection checkbox is not rendered");
  click(checkbox);
}

describe("the directory's bulk receipts", () => {
  it("names the list an audience was added to, and counts one contact as one", async () => {
    const { container, root } = await mountDirectory();
    try {
      selectAda(container);
      await settle();
      click(button("Add to list", container));
      await settle();
      const picker = container.querySelector<HTMLSelectElement>(
        'select[aria-label="Choose a list"]',
      );
      if (!picker) throw new Error("the list picker is not rendered");
      await act(async () => {
        picker.value = String(NEWSLETTER);
        picker.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      click(button("Add", container));
      await settle();

      expect(posted.map((request) => request.path)).toContain(
        "/api/v1/subscribers/bulk/add-to-list",
      );
      const receipt = toasts.at(-1)?.text;
      expect(receipt).toBe("Added 1 contact to Newsletter.");
    } finally {
      unmount(root);
    }
  });

  it("counts one deleted contact as one", async () => {
    const { container, root } = await mountDirectory();
    try {
      selectAda(container);
      await settle();
      // The bulk erase is behind a typed confirmation.
      click(button("Delete", container));
      await settle();
      const confirm = container.querySelector<HTMLInputElement>(
        'input[aria-label="Type DELETE to confirm"]',
      );
      if (!confirm) throw new Error("the typed confirmation is not rendered");
      type(confirm, "DELETE");
      await settle();
      click(button("Erase", container));
      await settle();

      expect(posted.map((request) => request.path)).toContain(
        "/api/v1/subscribers/bulk/delete",
      );
      expect(toasts.at(-1)?.text).toBe("Deleted 1 contact.");
    } finally {
      unmount(root);
    }
  });
});
