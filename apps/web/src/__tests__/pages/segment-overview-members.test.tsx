// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The segment overview shows who is in the segment the moment it exists.
//
// Its Members card could only list a snapshot's sample, so a new segment read
// "No snapshots yet" until someone pressed "Capture snapshot", and the header's
// live count ignored the segment's "Include archived" setting. Responses are
// the Go handlers' recorded bodies (fixtures/segments).
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import createdFixture from "../fixtures/segments/segment-create-201.json";
import membersFixture from "../fixtures/segments/segment-members.json";
import registry from "../fixtures/segments/predicate-registry.json";
import { renderPage, unmount, WHOAMI } from "./_harness";

const SEGMENT = { ...createdFixture, includeArchived: true };
// Another segment, for moving between overviews.
const OTHER = {
  ...SEGMENT,
  id: "3f0c2b7e-9a41-4d6f-8b2e-5c7d9e1f2a34",
  name: "Lapsed buyers",
};
let currentId = createdFixture.id;

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/subscribers/segments/[id]",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: currentId }),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi
    .fn()
    .mockResolvedValue({ ...WHOAMI, tenant_id: createdFixture.tenantId }),
}));

interface Seen {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
}
let seen: Seen[] = [];
let membersTotal = membersFixture.total;

beforeEach(() => {
  seen = [];
  currentId = createdFixture.id;
  membersTotal = membersFixture.total;
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
      seen.push({
        method,
        path: url.pathname,
        search: url.searchParams,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const reply = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      const other = `/api/v1/segments/${OTHER.id}`;
      if (url.pathname === other) return reply(OTHER);
      if (url.pathname === `${other}/members`) {
        return reply({
          ...membersFixture,
          archive_scope: "including_archived",
          total: membersTotal,
          page: Number(url.searchParams.get("page") ?? 1),
        });
      }
      const base = `/api/v1/segments/${createdFixture.id}`;
      switch (url.pathname) {
        case base:
          return reply(SEGMENT);
        case `${base}/members`:
          return reply({
            ...membersFixture,
            archive_scope: "including_archived",
            total: membersTotal,
            page: Number(url.searchParams.get("page") ?? 1),
          });
        case `${base}/snapshots`:
          return reply({ items: [] });
        case "/api/v1/segments/predicate-registry":
          return reply(registry);
        case "/api/v1/segments":
          return reply([SEGMENT]);
        default:
          return reply({ error: { code: "not_found", message: "" } }, 404);
      }
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mountOverview() {
  const Page = (
    await import("@/app/(dashboard)/app/subscribers/segments/[id]/page")
  ).default;
  return renderPage(Page, {
    params: Promise.resolve({ id: createdFixture.id }),
  });
}

function membersCard(container: HTMLElement): HTMLElement {
  const heading = [...container.querySelectorAll("h2")].find(
    (h) => h.textContent?.trim() === "Members",
  );
  const section = heading?.closest("section");
  if (!section) throw new Error("Members card not found");
  return section as HTMLElement;
}

describe("segment overview members", () => {
  it("lists the live members without a snapshot, each linked to the subscriber", async () => {
    const { container, root } = await mountOverview();
    try {
      const card = membersCard(container);
      expect(card.textContent).not.toContain("No snapshots yet");
      expect(card.textContent).toContain("archived subscribers included");
      for (const member of membersFixture.items) {
        const link = [...card.querySelectorAll("a")].find(
          (a) => a.textContent === member.email,
        );
        expect(link?.getAttribute("href")).toBe(
          `/app/subscribers/${member.subscriber_id}`,
        );
      }
      expect(card.textContent).toContain("Showing 1–2 of 2 members");
      expect(card.textContent).toContain("Freeze a snapshot");
      expect(
        seen.some(
          (r) =>
            r.path.endsWith("/members") && r.search.get("per_page") === "50",
        ),
      ).toBe(true);
      // The size trend asks for its window in the parameter the API reads.
      const history = seen.find((r) => r.path.endsWith("/size-history"));
      expect(history?.search.get("window")).toBe("90d");
      expect(history?.search.has("window_days")).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("pages through a large segment", async () => {
    membersTotal = 120;
    const { container, root } = await mountOverview();
    try {
      const card = membersCard(container);
      expect(card.textContent).toContain("Showing 1–50 of 120 members");
      const next = card.querySelector<HTMLButtonElement>(
        'button[aria-label="Next page of members"]',
      );
      expect(next?.disabled).toBe(false);
      await act(async () => next!.click());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(
        seen.some(
          (r) => r.path.endsWith("/members") && r.search.get("page") === "2",
        ),
      ).toBe(true);
      expect(membersCard(container).textContent).toContain(
        "Showing 51–100 of 120 members",
      );
    } finally {
      unmount(root);
    }
  });

  it("starts another segment's members on page one", async () => {
    membersTotal = 120;
    const Page = (
      await import("@/app/(dashboard)/app/subscribers/segments/[id]/page")
    ).default;
    // A client that keeps what it fetched, like the app's: returning to a
    // segment seen earlier renders its cached overview at once, with no
    // loading state in between to reset the members pager by accident.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const show = async (id: string) => {
      currentId = id;
      await act(async () => {
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            createElement(Page, { params: Promise.resolve({ id }) }),
          ),
        );
      });
      for (let i = 0; i < 12; i += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    };
    try {
      await show(OTHER.id);
      await show(createdFixture.id);
      await act(async () =>
        membersCard(container)
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Next page of members"]',
          )!
          .click(),
      );
      await show(createdFixture.id);
      expect(membersCard(container).textContent).toContain(
        "Showing 51–100 of 120 members",
      );

      await show(OTHER.id);
      expect(container.textContent).toContain("Lapsed buyers");
      expect(membersCard(container).textContent).toContain(
        "Showing 1–50 of 120 members",
      );
      expect(
        seen.some(
          (r) =>
            r.path === `/api/v1/segments/${OTHER.id}/members` &&
            r.search.get("page") === "2",
        ),
      ).toBe(false);
    } finally {
      unmount(root);
      client.clear();
    }
  });

  it("counts the header's live preview under the segment's own archive scope", async () => {
    const { root } = await mountOverview();
    try {
      // LiveCount debounces its preview by 500 ms.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
      });
      const preview = seen.find(
        (r) => r.method === "POST" && r.path === "/api/v1/segments/preview",
      );
      expect(preview?.body).toMatchObject({ include_archived: true });
    } finally {
      unmount(root);
    }
  });
});
