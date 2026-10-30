// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// platform-65 — the outbound-destination administration summary on
// /app/routing. Asserts the CONSEQUENCE: the exact read the page sends
// (GET /api/v1/outbound-webhooks?limit=200 through lib/outbound-webhooks-api),
// the counts it renders from the server payload, the lower-bound marking
// when the server reports another page, and that a non-admin sends nothing.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RoutingPage from "@/app/(dashboard)/app/routing/page";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/routing",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth-api")>("@/lib/auth-api");
  return { ...actual, whoami: mocks.whoami };
});

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api: { ...actual.api, get: mocks.apiGet } };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.test",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "QA",
  workspace_slug: "qa",
} as const;

const EDITOR = { ...OWNER, role: "editor", effective_role: "editor" } as const;

function hook(overrides: Record<string, unknown>) {
  return {
    id: "wh-default",
    url: "https://hooks.example.test/…",
    events: ["campaign.sent"],
    active: true,
    consecutive_failures: 0,
    ...overrides,
  };
}

const HOOKS = [
  hook({ id: "wh-1", events: ["campaign.sent", "email.bounced"] }),
  hook({
    id: "wh-2",
    active: true,
    consecutive_failures: 3,
    events: ["email.bounced"],
  }),
  hook({
    id: "wh-3",
    active: false,
    disabled_reason: "auto_failures",
    events: ["subscriber.added"],
  }),
];

let listing: { webhooks: unknown[]; next_cursor: string };

function installServer() {
  mocks.apiGet.mockImplementation((path: string) => {
    if (path.startsWith("/api/v1/outbound-webhooks")) {
      return Promise.resolve(listing);
    }
    return Promise.reject(new Error(`unmocked ${path}`));
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderPage() {
  container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await act(async () => {
    root = createRoot(container!);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(RoutingPage),
      ),
    );
  });
  for (let turn = 0; turn < 10; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

function summaryValues(scope: ParentNode): Record<string, string> {
  const list = scope.querySelector(
    'dl[aria-label="Outbound destination summary"]',
  );
  if (!list) throw new Error("summary not rendered");
  const out: Record<string, string> = {};
  for (const cell of list.querySelectorAll("div")) {
    const label = cell.querySelector("dt")?.textContent ?? "";
    out[label] = cell.querySelector("dd")?.textContent ?? "";
  }
  return out;
}

beforeEach(() => {
  listing = { webhooks: HOOKS, next_cursor: "" };
  installServer();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

describe("routing page outbound destination summary", () => {
  it("reads the widest page through the strict client and counts the payload", async () => {
    mocks.whoami.mockResolvedValue(OWNER);
    const scope = await renderPage();

    const reads = mocks.apiGet.mock.calls.filter(([path]) =>
      String(path).startsWith("/api/v1/outbound-webhooks"),
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]![0]).toBe("/api/v1/outbound-webhooks?limit=200");

    expect(summaryValues(scope)).toEqual({
      Destinations: "3",
      Active: "2",
      Paused: "1",
      "Need attention": "2",
      "Event types": "3",
    });
    expect(scope.textContent).not.toContain("lower bounds");
  });

  it("marks every count as a lower bound when the server reports another page", async () => {
    mocks.whoami.mockResolvedValue(OWNER);
    listing = { webhooks: HOOKS, next_cursor: "opaque-next" };
    const scope = await renderPage();

    expect(summaryValues(scope)).toMatchObject({
      Destinations: "3+",
      Active: "2+",
      "Need attention": "2+",
    });
    expect(scope.textContent).toContain(
      "Counts are lower bounds from the first 3 destinations",
    );
  });

  it("refuses a malformed record instead of counting it", async () => {
    mocks.whoami.mockResolvedValue(OWNER);
    listing = {
      webhooks: [
        ...HOOKS,
        { id: "wh-bad", url: "x", active: "yes", events: [] },
      ],
      next_cursor: "",
    };
    const scope = await renderPage();

    expect(
      scope.querySelector('dl[aria-label="Outbound destination summary"]'),
    ).toBeNull();
    expect(scope.textContent).toContain(
      "Outbound webhooks could not be loaded",
    );
  });

  it("sends no admin-only read for a role that cannot manage destinations", async () => {
    mocks.whoami.mockResolvedValue(EDITOR);
    const scope = await renderPage();

    expect(
      mocks.apiGet.mock.calls.some(([path]) =>
        String(path).startsWith("/api/v1/outbound-webhooks"),
      ),
    ).toBe(false);
    expect(scope.textContent).toContain("Administrator access required");
  });
});
