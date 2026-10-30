// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// A campaign delete held for its Undo window must survive the page going away.
//
// The list removes the row immediately and holds the DELETE for a few seconds so
// Undo can cancel it. That hold lived only in a window timer, so closing the tab
// inside the window threw the request away: the row had disappeared, and the
// campaign was still there on the next visit. These tests drive the real list
// over the recorded campaigns fixture and watch the transport.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, stubFixtureTransport, unmount, WHOAMI } from "./_harness";
import { importBeforeTests } from "./_wait";
import { button, click, topDialog } from "../helpers/subscriber-directory-harness";

const WIN_BACK_ID = "00000000-0000-4000-8000-000000000001";

const navigation = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() },
}));
const auth = vi.hoisted(() => ({ whoami: vi.fn(), whoamiFresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation.router,
  usePathname: () => "/app/campaigns",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: auth.whoami,
  whoamiFresh: auth.whoamiFresh,
}));

// renderPage mounts the page, not the app shell that carries <Toaster/>, so a
// real toast renders nowhere. The recorder keeps each notice and its action, which
// is how the test presses Undo.
const toasts = vi.hoisted(
  () => [] as { level: string; text: string; action?: { label: string; onClick: () => void } }[],
);
vi.mock("sonner", () => {
  const record =
    (level: string) =>
    (message: unknown, options?: { action?: { label: string; onClick: () => void } }) => {
      toasts.push({ level, text: String(message), action: options?.action });
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

importBeforeTests(() => import("@/app/(dashboard)/app/campaigns/campaigns-client"));

interface Recorded {
  method: string;
  path: string;
  keepalive: boolean;
}

const sent: Recorded[] = [];

/** The fixture transport, with DELETEs answered and recorded. */
function stubTransport(): void {
  stubFixtureTransport();
  const fixture = globalThis.fetch as unknown as (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
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
      if (method === "DELETE") {
        sent.push({ method, path: url.pathname, keepalive: init?.keepalive === true });
        return new Response(null, { status: 204 });
      }
      return fixture(input, init);
    }),
  );
}

function deletesOf(id: string): Recorded[] {
  return sent.filter((request) => request.path === `/api/v1/campaigns/${id}`);
}

async function waitFor<T>(probe: () => T | null | undefined | false, label: string): Promise<T> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    let value: T | null | undefined | false = null;
    try {
      value = probe();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

/** Asks for the first campaign's delete and waits for its row to go. */
async function requestDelete(container: HTMLElement): Promise<void> {
  click(button(/^Delete Win-back$/, container));
  const dialog = await waitFor(() => (topDialog().textContent?.includes("Delete campaign?") ? topDialog() : null), "the confirm dialog");
  click(button("Delete", dialog));
  await waitFor(() => !container.textContent?.includes("Win-back"), "the row to disappear");
}

async function hide(event: "pagehide" | "visibilitychange"): Promise<void> {
  await act(async () => {
    if (event === "pagehide") {
      window.dispatchEvent(new Event("pagehide"));
    } else {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function toastWithAction(label: string) {
  const match = [...toasts].reverse().find((entry) => entry.action?.label === label);
  if (!match?.action) throw new Error(`No toast offered "${label}": ${JSON.stringify(toasts)}`);
  return match.action;
}

beforeEach(() => {
  sent.length = 0;
  toasts.length = 0;
  vi.clearAllMocks();
  auth.whoami.mockResolvedValue(WHOAMI);
  auth.whoamiFresh.mockResolvedValue(WHOAMI);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  stubTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function mountList() {
  const { CampaignsClient } = await import("@/app/(dashboard)/app/campaigns/campaigns-client");
  return renderPage(CampaignsClient);
}

describe("a campaign delete held for its Undo window", () => {
  it("is sent when the page goes away inside the window", async () => {
    const { container, root } = await mountList();
    try {
      await requestDelete(container);
      // Nothing has been sent yet: the window is still open.
      expect(deletesOf(WIN_BACK_ID)).toEqual([]);

      await hide("pagehide");
      const requests = deletesOf(WIN_BACK_ID);
      expect(requests).toHaveLength(1);
      // keepalive is what lets the browser finish it after the page is gone.
      expect(requests[0].keepalive).toBe(true);

      // And only once, however many times the page is torn down.
      await hide("pagehide");
      expect(deletesOf(WIN_BACK_ID)).toHaveLength(1);
    } finally {
      unmount(root);
    }
  });

  it("is sent when the tab is backgrounded, which pagehide can miss", async () => {
    const { container, root } = await mountList();
    try {
      await requestDelete(container);
      await hide("visibilitychange");
      expect(deletesOf(WIN_BACK_ID)).toHaveLength(1);
    } finally {
      unmount(root);
    }
  });

  it("is never sent after Undo, not even when the page goes away", async () => {
    const { container, root } = await mountList();
    try {
      await requestDelete(container);
      expect(toasts.at(-1)?.text).toContain("Deleting \"Win-back\"");
      await act(async () => {
        toastWithAction("Undo").onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await hide("pagehide");
      expect(deletesOf(WIN_BACK_ID)).toEqual([]);
      // The row is back, because the list was re-read.
      await waitFor(() => container.textContent?.includes("Win-back"), "the restored row");
    } finally {
      unmount(root);
    }
  });

  it("commits on its own when the window elapses, and says so once", async () => {
    const { container, root } = await mountList();
    try {
      // Fake timers go in BEFORE the delete is requested: a timer the real clock
      // owns is invisible to the fake one. shouldAdvanceTime keeps the awaits in
      // this test resolving.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await requestDelete(container);
      await act(async () => {
        vi.advanceTimersByTime(6_000);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const requests = await waitFor(() => {
        const found = deletesOf(WIN_BACK_ID);
        return found.length > 0 ? found : null;
      }, "the deferred delete");
      expect(requests).toHaveLength(1);
      // The timer path is a normal request, not an unload one.
      expect(requests[0].keepalive).toBe(false);
      // A later teardown must not repeat it.
      await hide("pagehide");
      expect(deletesOf(WIN_BACK_ID)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      unmount(root);
    }
  });
});
