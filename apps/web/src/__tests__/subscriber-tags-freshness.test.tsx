// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// A tag added on a subscriber's profile must reach what the tag moves
// (CACHE-09, same-defect follow-up): the tag panel refetched only the record,
// so a segment defined by that tag kept saying "Not a member of any segment"
// and the activity timeline kept its pre-write events for their staleTime.
//
// The real tag panel and the real timeline hook the page uses, over ONE
// QueryClient, in front of an in-memory API: segment membership and the
// timeline are computed from the subscriber's current tags.

import { act, createElement, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "./_roots";
import { importBeforeTests, waitFor } from "./pages/_wait";

const SUBSCRIBER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const mocks = vi.hoisted(() => ({
  tags: [] as string[],
  requests: [] as string[],
  whoami: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

async function serve(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  mocks.requests.push(`${method} ${path}`);
  const base = `/api/v1/subscribers/${SUBSCRIBER_ID}`;
  if (method === "GET" && path === `${base}/segment-membership`) {
    const member = mocks.tags.includes("vip");
    return {
      subscriber_id: SUBSCRIBER_ID,
      segments: [
        {
          segment_id: "55555555-5555-4555-8555-555555555555",
          segment_name: "VIP customers",
          is_member: member,
          matched_count: member ? 1 : 0,
          total_conditions: 1,
          summary: "tag is vip",
        },
      ],
    };
  }
  if (method === "GET" && path === `${base}/groups`) {
    return { subscriber_id: SUBSCRIBER_ID, groups: [] };
  }
  if (method === "GET" && path === `${base}/timeline`) {
    return {
      subscriber_id: SUBSCRIBER_ID,
      email: "bob@example.com",
      stats: {
        sent_count: 0,
        opened_count: 0,
        clicked_count: 0,
        bounced_count: 0,
        replied_count: 0,
        open_rate: 0,
        click_rate: 0,
        engagement_score: 0,
        subscribed_at: "2026-09-01T00:00:00Z",
        current_status: "enabled",
      },
      events: mocks.tags.map((tag) => ({
        type: "tag_added",
        occurred_at: "2026-09-15T03:00:00Z",
        source: "dashboard",
        subject: tag,
      })),
      pagination: { limit: 50, has_more: false },
    };
  }
  if (method === "POST" && path === "/api/v1/subscribers/bulk/tag") {
    const { tag } = body as { tag: string };
    if (!mocks.tags.includes(tag)) mocks.tags.push(tag);
    return { affected: 1, source: "explicit_ids" };
  }
  throw Object.assign(new Error(`not found: ${method} ${path}`), {
    status: 404,
  });
}

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: (path: string) => serve("GET", path),
      post: (path: string, body?: unknown) => serve("POST", path, body),
    },
  };
});
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoami,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OPERATOR = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "operator@example.com",
  role: "owner" as const,
  effective_role: "admin" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Acme Outfitters",
  workspace_slug: "acme",
};

importBeforeTests(
  () => import("@/app/(dashboard)/app/subscribers/[id]/_profile-panels"),
  () => import("@/app/(dashboard)/app/subscribers/[id]/use-subscriber-timeline"),
);

beforeEach(() => {
  mocks.tags = [];
  mocks.requests = [];
  mocks.whoami.mockResolvedValue(OPERATOR);
});

afterEach(() => {
  unmountRoots();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("a profile tag change reaches what the tag moves", () => {
  it("adding a tag refreshes the tag-defined segment membership and the timeline", async () => {
    const [{ ListsTagsPanel }, { useSubscriberTimeline }] = await Promise.all([
      import("@/app/(dashboard)/app/subscribers/[id]/_profile-panels"),
      import("@/app/(dashboard)/app/subscribers/[id]/use-subscriber-timeline"),
    ]);

    // The page's composition: its record (the tags the panel shows, refetched
    // through onTagsChanged) and its activity timeline hook.
    function ProfilePage(): ReactNode {
      const [tags, setTags] = useState<string[]>([]);
      const { timeline } = useSubscriberTimeline({
        enabled: true,
        id: SUBSCRIBER_ID,
        role: "admin",
        tenantId: OPERATOR.tenant_id,
        category: "all",
      });
      return (
        <>
          <ListsTagsPanel
            id={SUBSCRIBER_ID}
            subscriber={
              {
                id: SUBSCRIBER_ID,
                email: "bob@example.com",
                status: "enabled",
                tags,
                custom_fields: {},
              } as never
            }
            enabled
            onTagsChanged={() => setTags([...mocks.tags])}
          />
          <ol data-testid="timeline">
            {(timeline?.events ?? []).map((e, i) => (
              <li key={i}>
                {e.type}: {e.subject}
              </li>
            ))}
          </ol>
        </>
      );
    }

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = trackRoot(container);
    act(() => {
      root.render(
        createElement(QueryClientProvider, { client }, <ProfilePage />),
      );
    });

    const tagInput = () =>
      container.querySelector<HTMLInputElement>('input[aria-label="Add a tag"]');
    await waitFor(() => {
      expect(container.textContent).toContain("Not a member of any segment.");
      expect(tagInput()?.disabled).toBe(false);
    });

    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(tagInput(), "vip");
      tagInput()!.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    await act(async () => {
      tagInput()!.form!.requestSubmit();
      await flush();
    });
    expect(mocks.requests).toContain("POST /api/v1/subscribers/bulk/tag");

    await waitFor(() => {
      expect({
        segments: container.textContent?.includes("VIP customers"),
        timeline: container.querySelector('[data-testid="timeline"]')?.textContent,
      }).toEqual({ segments: true, timeline: "tag_added: vip" });
    });
  });

  it("claims no segment membership while the session is still loading", async () => {
    const { ListsTagsPanel } = await import(
      "@/app/(dashboard)/app/subscribers/[id]/_profile-panels"
    );
    mocks.tags = ["vip"];
    let resolveSession: (me: typeof OPERATOR) => void = () => undefined;
    mocks.whoami.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = trackRoot(container);
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          <ListsTagsPanel
            id={SUBSCRIBER_ID}
            subscriber={
              {
                id: SUBSCRIBER_ID,
                email: "bob@example.com",
                status: "enabled",
                tags: ["vip"],
                custom_fields: {},
              } as never
            }
            enabled
            onTagsChanged={() => undefined}
          />,
        ),
      );
    });
    await act(async () => {
      await flush();
    });
    expect(container.textContent).not.toContain("Not a member of any segment.");

    await act(async () => {
      resolveSession(OPERATOR);
      await flush();
    });
    await waitFor(() => {
      expect(container.textContent).toContain("VIP customers");
    });
  });
});
