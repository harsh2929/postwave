// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The subscribers directory toolbar is LIVE on /app/subscribers: it mounts
// under the page's search box, and what it writes is the page's own list
// state. This mounts the real page over the real transport (global fetch
// stubbed) and asserts the page's 50-row list request changes with each
// control — so a toolbar that only rewrote the URL, or a page that ignored
// the params, goes red. Also pins the pre-existing "Show archived" toggle
// (audience-3), which the parity register listed as missing.
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

import { renderPage, unmount } from "./_harness";
import {
  byAriaLabel,
  button,
  click,
  navStore,
  type,
} from "../helpers/subscriber-directory-harness";

const requests: URL[] = [];

/** The page's own 50-row search requests (the chips' totals ask for one row). */
function searchRequests(): URLSearchParams[] {
  return requests
    .filter(
      (url) =>
        url.pathname === "/api/v1/subscribers/search" &&
        url.searchParams.get("per_page") === "50",
    )
    .map((url) => url.searchParams);
}

function listRequests(): URLSearchParams[] {
  return requests
    .filter(
      (url) =>
        url.pathname === "/api/v1/subscribers" &&
        url.searchParams.get("per_page") === "50",
    )
    .map((url) => url.searchParams);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  requests.length = 0;
  navStore.reset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const url = new URL(raw, "http://localhost");
      requests.push(url);
      if (url.pathname === "/api/v1/subscribers" || url.pathname === "/api/v1/subscribers/search") {
        return new Response(
          JSON.stringify({ items: [], total: 42, page: 1, per_page: Number(url.searchParams.get("per_page")) }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: { code: "not_found", message: "" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("subscribers page with the directory toolbar", () => {
  it("drives the page's own list request from the toolbar and the archived toggle", async () => {
    const Page = (await import("@/app/(dashboard)/app/subscribers/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      const chips = byAriaLabel("Filter subscribers by status", container);
      expect(chips).toBeTruthy();
      const first = listRequests().at(-1);
      expect(first?.get("status")).toBeNull();

      click(button(/^Disabled/, chips));
      await settle();
      expect(navStore.params().get("status")).toBe("disabled");
      expect(listRequests().at(-1)?.get("status")).toBe("disabled");

      type(byAriaLabel<HTMLSelectElement>("Sort subscribers by", container), "engagement");
      await settle();
      const sorted = listRequests().at(-1);
      expect(sorted?.get("sort")).toBe("engagement");
      expect(sorted?.get("order")).toBe("desc");
      expect(sorted?.get("status")).toBe("disabled");

      const archived = [...container.querySelectorAll("label")]
        .find((label) => label.textContent?.trim() === "Show archived")
        ?.querySelector("input");
      if (!archived) throw new Error("Show archived toggle not rendered");
      click(archived);
      await settle();
      expect(navStore.params().get("archived")).toBe("1");
      expect(listRequests().at(-1)?.get("include_archived")).toBe("true");

      click(button("Reset view", container));
      await settle();
      const reset = listRequests().at(-1);
      expect(navStore.get()).toBe("");
      expect(reset?.get("status")).toBeNull();
      expect(reset?.get("include_archived")).toBeNull();
      expect(reset?.get("sort")).toBe("updated_at");

      const search = byAriaLabel<HTMLInputElement>("Search subscribers", container);
      act(() => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
      });
      expect(document.activeElement).toBe(search);
    } finally {
      unmount(root);
      // Let queries that were already in flight at unmount resolve against the
      // stub; unstubbing first would hand them the real fetch.
      await settle();
    }
  }, 30_000);

  // Staging: with "Show archived" on, archived contacts listed until the
  // operator typed a query; the search request went out without the flag and
  // the API (which hides archived rows unless asked) dropped them.
  it("keeps Show archived applied while a search is active", async () => {
    navStore.set("q=verify-check");
    const Page = (await import("@/app/(dashboard)/app/subscribers/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      await settle();
      const first = searchRequests().at(-1);
      expect(first?.get("q")).toBe("verify-check");
      expect(first?.get("include_archived")).toBeNull();

      const archived = [...container.querySelectorAll("label")]
        .find((label) => label.textContent?.trim() === "Show archived")
        ?.querySelector("input");
      if (!archived) throw new Error("Show archived toggle not rendered");
      click(archived);
      await settle();
      expect(navStore.params().get("archived")).toBe("1");
      const withArchived = searchRequests().at(-1);
      expect(withArchived?.get("q")).toBe("verify-check");
      expect(withArchived?.get("include_archived")).toBe("true");
      // The status chips count the same view, so their search totals must
      // include archived contacts too.
      const totals = requests.filter(
        (url) =>
          url.pathname === "/api/v1/subscribers/search" &&
          url.searchParams.get("per_page") === "1",
      );
      expect(totals.at(-1)?.searchParams.get("include_archived")).toBe("true");
    } finally {
      unmount(root);
      await settle();
    }
  }, 30_000);
});
