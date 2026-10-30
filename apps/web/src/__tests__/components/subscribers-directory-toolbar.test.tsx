// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Parity rows audience-2/4/6/10/14/15/32/35/36/38 — the subscribers directory
// toolbar mounted under the search box on /app/subscribers.
//
// Every control writes the page's OWN URL state (the params the page parses),
// so the assertions are on the URL a control produces and the request it makes
// — not on the control existing. The page-level test
// (pages/subscribers-directory-live.test.tsx) proves the page then refetches
// its list with that state.
import { act, createElement, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code = `http_${status}`,
    ) {
      super(message);
    }
  }
  return {
    MockApiError,
    get: vi.fn(
      async (
        _path: string,
        _opts?: { query?: Record<string, unknown>; signal?: AbortSignal },
      ): Promise<unknown> => ({}),
    ),
    post: vi.fn(
      async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> => ({}),
    ),
    patch: vi.fn(
      async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> => ({}),
    ),
    put: vi.fn(
      async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> => ({}),
    ),
    del: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => undefined),
    whoami: vi.fn(),
    whoamiFresh: vi.fn(),
    bus: {
      handler: null as null | ((event: { topic: string; payload?: Record<string, unknown> }) => void),
      options: null as unknown,
    },
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      message: vi.fn(),
    },
  };
});

vi.mock("next/navigation", async () =>
  (await import("../helpers/subscriber-directory-harness")).navigationMock(),
);
vi.mock("@/lib/api", () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    put: mocks.put,
    delete: mocks.del,
  },
  ApiError: mocks.MockApiError,
  isApiError: (error: unknown) => error instanceof mocks.MockApiError,
  apiErrorMessage: (error: unknown, fallback = "Something went wrong") =>
    error instanceof Error && error.message ? error.message : fallback,
}));
vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));
vi.mock("@/lib/realtime/event-bus-client", () => ({
  connectRealtimeBus: vi.fn(
    (
      handler: (event: { topic: string; payload?: Record<string, unknown> }) => void,
      _onStatus?: unknown,
      options?: unknown,
    ) => {
      mocks.bus.handler = handler;
      mocks.bus.options = options;
      return () => {
        mocks.bus.handler = null;
      };
    },
  ),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { DirectoryToolbar } from "@/components/subscribers/DirectoryToolbar";
import { useDirectoryKeyboardShortcuts } from "@/components/subscribers/useDirectoryKeyboardShortcuts";
import { SubscribersSearchForm } from "@/app/(dashboard)/app/subscribers/subscribers-search-form";
import {
  directoryViewFromPredicate,
  directoryViewPredicate,
  waitForLookalikeTerminal,
  type LookalikeAudience,
} from "@/lib/subscriber-directory-api";

import {
  button,
  byAriaLabel,
  cleanup,
  click,
  field,
  flush,
  navStore,
  queryButton,
  render,
  topDialog,
  type,
} from "../helpers/subscriber-directory-harness";

const TENANT = "22222222-2222-4222-8222-222222222222";
const OWNER = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: TENANT,
  email: "ada@example.com",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
};
const VIEWER = { ...OWNER, role: "viewer", effective_role: "viewer" };

const TOTALS: Record<string, number> = {
  all: 1200,
  enabled: 900,
  blocklisted: 150,
  disabled: 42,
  unconfirmed: 108,
};

const SEG = "33333333-3333-4333-8333-333333333333";
const SEG_TINY = "44444444-4444-4444-8444-444444444444";
const DEST = "55555555-5555-4555-8555-555555555555";
const LOOKALIKE = "66666666-6666-4666-8666-666666666666";

function audience(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: LOOKALIKE,
    name: "Lookalike audience",
    seed_segment_id: SEG,
    size_requested: 500,
    member_count: 480,
    seed_count: 120,
    confidence_threshold: 0.9,
    model_version: "first-party-v1",
    status: "ready",
    payload: {},
    created_at: "2026-09-12T08:00:00Z",
    updated_at: "2026-09-12T08:00:00Z",
    ...overrides,
  };
}

const V3_ROW = {
  id: "sv_v3",
  tenant_id: TENANT,
  name: "Churn risks",
  description: "",
  visibility_scope: "workspace",
  is_pinned: false,
  last_count: 30,
  predicate_json: {
    filters: { status: "blocklisted", q: "acme" },
    snapshot: {
      version: 3,
      resource_scope: "subscriber_directory",
      workspace_scope: "current",
      applied_query: "acme",
      status: "unsubscribed",
      include_archived: true,
      sort: { column: "churn_score", order: "asc" },
      columns: ["avatar", "email", "churn_score"],
      reset: { page: 1, selection: "clear" },
    },
  },
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};
const AST_ROW = {
  ...V3_ROW,
  id: "sv_ast",
  name: "Complex AST",
  visibility_scope: "personal",
  last_count: null,
  predicate_json: { ast: { op: "and", children: [] } },
};

let savedRows: unknown[] = [];

function routeGet(path: string, query: Record<string, unknown> = {}): unknown {
  switch (path) {
    case "/api/v1/subscribers": {
      const status = String(query.status ?? "all");
      const extra = query.include_archived === "true" ? 7 : 0;
      return { items: [], total: (TOTALS[status] ?? 0) + extra, page: 1, per_page: 1 };
    }
    case "/api/v1/subscribers/search":
      return { items: [], total: 3, page: 1, per_page: 1 };
    case "/api/v1/dashboard/stats":
      return { subscribers_added_30d: 80, subscribers_unsubbed_30d: 24 };
    case "/api/v1/segments/saved":
      return { items: savedRows, total_items: savedRows.length, max_items: 200 };
    case "/api/v1/segments/saved/sv_v3/preview":
      return {
        id: "sv_v3",
        count: 37,
        workspace_total: 1200,
        workspace_percentage: 3.1,
        generated_at: "2026-09-12T08:00:00Z",
      };
    case "/api/v1/me/prefs/subscribers_view":
      return { columns: ["email", "status", "rating"], widths: { email: 240 }, sort: "", order: "" };
    case "/api/v1/segments":
      return [
        { id: SEG, name: "VIPs", lastCount: 120 },
        { id: SEG_TINY, name: "Tiny", lastCount: 10 },
      ];
    case "/api/v1/subscribers/lookalike":
      return { items: [audience({ id: "77777777-7777-4777-8777-777777777777", name: "Older model" })] };
    case "/api/v1/audience-destinations":
      return {
        items: [
          { id: DEST, provider: "meta", status: "active" },
          { id: "88888888-8888-4888-8888-888888888888", provider: "tiktok", status: "disconnected" },
        ],
      };
    default:
      throw new mocks.MockApiError(`unexpected GET ${path}`, 404);
  }
}

function getCalls(path: string) {
  return mocks.get.mock.calls.filter((call) => call[0] === path);
}

beforeEach(() => {
  vi.clearAllMocks();
  navStore.reset();
  savedRows = [V3_ROW, AST_ROW];
  mocks.whoami.mockResolvedValue(OWNER);
  mocks.whoamiFresh.mockResolvedValue(OWNER);
  mocks.get.mockImplementation(async (path, opts) => routeGet(path, opts?.query ?? {}));
  mocks.post.mockImplementation(async (path, body) => {
    if (path === "/api/v1/segments/saved") {
      const input = body as Record<string, unknown>;
      return {
        id: "sv_new",
        tenant_id: TENANT,
        name: input.name,
        description: "",
        visibility_scope: input.visibility_scope,
        is_pinned: false,
        predicate_json: input.predicate_json,
        created_at: "2026-09-12T08:00:00Z",
        updated_at: "2026-09-12T08:00:00Z",
      };
    }
    if (path === "/api/v1/subscribers/lookalike") return audience();
    if (path === `/api/v1/subscribers/lookalike/${LOOKALIKE}/export`)
      return audience({ exported_destination_id: DEST });
    throw new mocks.MockApiError(`unexpected POST ${path}`, 404);
  });
  mocks.patch.mockResolvedValue({});
  mocks.del.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
});

function mountToolbar(search = "") {
  navStore.set(search);
  return render(createElement(DirectoryToolbar));
}

function chip(label: string): HTMLButtonElement {
  const group = byAriaLabel("Filter subscribers by status");
  return button(new RegExp(`^${label}`), group);
}

describe("status chips (audience-2)", () => {
  it("offers all four engine states plus All and counts the active view", async () => {
    mountToolbar();
    await flush();

    expect(chip("All").getAttribute("aria-pressed")).toBe("true");
    expect(chip("All").textContent).toContain("1,200");

    const expected: [string, string, string][] = [
      ["Subscribed", "enabled", "enabled"],
      ["Unsubscribed", "suppressed", "blocklisted"],
      ["Disabled", "disabled", "disabled"],
      ["Unconfirmed", "pending", "unconfirmed"],
    ];
    for (const [label, urlValue, engine] of expected) {
      click(chip(label));
      await flush();
      expect(navStore.params().get("status")).toBe(urlValue);
      expect(navStore.params().get("page")).toBeNull();
      expect(mocks.get).toHaveBeenCalledWith("/api/v1/subscribers", {
        query: { page: 1, per_page: 1, status: engine, include_archived: undefined },
        signal: expect.any(AbortSignal),
      });
      expect(chip(label).getAttribute("aria-pressed")).toBe("true");
      expect(chip(label).textContent).toContain(TOTALS[engine].toLocaleString());
    }

    click(chip("All"));
    await flush();
    expect(navStore.get()).toBe("");
  });

  it("counts a text search through the search endpoint with the status folded in", async () => {
    mountToolbar("q=ada&status=disabled");
    await flush();
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/subscribers/search", {
      query: { q: "ada status:disabled", page: 1, per_page: 1, include_archived: undefined },
      signal: expect.any(AbortSignal),
    });
    expect(chip("Disabled").textContent).toContain("3");
  });

  it("counts archived contacts in a search when Show archived is on", async () => {
    mountToolbar("q=ada&archived=1");
    await flush();
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/subscribers/search", {
      query: { q: "ada", page: 1, per_page: 1, include_archived: "true" },
      signal: expect.any(AbortSignal),
    });
  });
});

describe("server sort (audience-4)", () => {
  it("writes a server-side sort key and order into the page URL", async () => {
    mountToolbar("page=4");
    await flush();
    const select = byAriaLabel<HTMLSelectElement>("Sort subscribers by");
    const options = [...select.options].map((option) => option.value);
    expect(options).toEqual([
      "updated_at",
      "created_at",
      "email",
      "status",
      "engagement",
      "rating",
      "churn",
      "first_name",
      "last_name",
    ]);

    type(select, "engagement");
    await flush();
    expect(navStore.params().get("sort")).toBe("engagement");
    expect(navStore.params().get("order")).toBeNull(); // desc is the default
    expect(navStore.params().get("page")).toBeNull();

    click(button("Sorted descending — switch to ascending"));
    await flush();
    expect(navStore.params().get("order")).toBe("asc");
    expect(navStore.params().get("sort")).toBe("engagement");
  });

  it("withholds sorting while a relevance-ranked search is applied", async () => {
    mountToolbar("q=ada");
    await flush();
    const select = byAriaLabel<HTMLSelectElement>("Sort subscribers by");
    expect(select.disabled).toBe(true);
    expect(select.title).toBe("Search results are ranked by relevance; clear the search to sort.");
  });
});

describe("refresh and reset (audience-6, audience-15)", () => {
  it("refetches every subscribers read for the identity and reports a failure", async () => {
    mountToolbar();
    await flush();
    const before = getCalls("/api/v1/subscribers").length;
    const statsBefore = getCalls("/api/v1/dashboard/stats").length;

    click(button("Refresh"));
    await flush();
    expect(getCalls("/api/v1/subscribers").length).toBeGreaterThan(before);
    expect(getCalls("/api/v1/dashboard/stats").length).toBeGreaterThan(statsBefore);
    expect(mocks.toast.error).not.toHaveBeenCalled();

    mocks.get.mockImplementation(async (path) => {
      if (path === "/api/v1/subscribers") throw new mocks.MockApiError("down", 503);
      return routeGet(path);
    });
    click(button("Refresh"));
    await flush();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Some subscriber data could not be refreshed.",
    );
  });

  it("resets query, status, archived, sort and page to the default view", async () => {
    mountToolbar();
    await flush();
    expect(queryButton("Reset view")).toBeNull();
    cleanup();

    mountToolbar("q=ada&status=disabled&archived=1&sort=churn&order=asc&page=3");
    await flush();
    click(button("Reset view"));
    await flush();
    expect(navStore.get()).toBe("");
    expect(queryButton("Reset view")).toBeNull();
  });
});

describe("insights strip (audience-38)", () => {
  it("shows workspace total, the applied view's total and net new over 30 days", async () => {
    mountToolbar("status=disabled");
    await flush();
    const strip = byAriaLabel("Directory insights");
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/dashboard/stats", {
      query: { range: "30d", compare: "false", sparklines: "false" },
      signal: expect.any(AbortSignal),
    });
    expect(strip.textContent).toContain("Workspace total1,200");
    expect(strip.textContent).toContain("This view42");
    expect(strip.textContent).toContain("+56");
    expect(strip.textContent).toContain("+80 added · 24 unsubscribed");
  });

  it("says a figure is unavailable instead of rendering zero", async () => {
    mocks.get.mockImplementation(async (path) => {
      if (path === "/api/v1/subscribers") throw new mocks.MockApiError("down", 503);
      if (path === "/api/v1/dashboard/stats") throw new mocks.MockApiError("down", 503);
      return routeGet(path);
    });
    mountToolbar();
    await flush();
    const strip = byAriaLabel("Directory insights");
    expect(strip.textContent).toContain("Workspace totalunavailable");
    expect(strip.textContent).toContain("This viewunavailable");
    expect(strip.textContent).not.toMatch(/Workspace total0/);
  });
});

describe("saved views (audience-35, audience-36)", () => {
  async function openSaved(search = "") {
    mountToolbar(search);
    await flush();
    click(button("Saved views"));
    await flush();
    return topDialog();
  }

  it("applies a desktop-saved v3 view to the page URL, previews it and marks it used", async () => {
    const dialog = await openSaved();
    expect(dialog.textContent).toContain("Churn risks");
    expect(dialog.textContent).toContain("Unsubscribed · “acme” · incl. archived · Churn score ↑");
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/segments/saved/sv_v3/preview", {
      signal: expect.any(AbortSignal),
    });
    expect(dialog.textContent).toContain("37 match now");

    const row = [...dialog.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("Churn risks"),
    ) as HTMLElement;
    click(button("Apply", row));
    await flush();

    const params = navStore.params();
    expect(params.get("q")).toBe("acme");
    expect(params.get("status")).toBe("suppressed");
    expect(params.get("archived")).toBe("1");
    expect(params.get("sort")).toBe("churn");
    expect(params.get("order")).toBe("asc");
    expect(params.get("page")).toBeNull();
    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/v1/segments/saved/sv_v3",
      { touch: true },
      { maxAttempts: 1 },
    );
  });

  it("refuses to apply a predicate that is not a directory view", async () => {
    const dialog = await openSaved();
    const row = [...dialog.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("Complex AST"),
    ) as HTMLElement;
    expect(row.textContent).toContain("Not a directory view");
    expect(button("Apply", row).disabled).toBe(true);
  });

  it("saves the current view as the v3 snapshot desktop applies", async () => {
    const dialog = await openSaved("status=pending&sort=engagement&archived=1");
    type(field("Save the current view as", dialog), "  Cold unconfirmed ");
    type(field("Visible to", dialog), "workspace");
    click(button("Save view", dialog));
    await flush();

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/segments/saved",
      {
        name: "Cold unconfirmed",
        visibility_scope: "workspace",
        predicate_json: {
          filters: { status: "unconfirmed", q: "" },
          snapshot: {
            version: 3,
            resource_scope: "subscriber_directory",
            workspace_scope: "current",
            applied_query: "",
            status: "unconfirmed",
            include_archived: true,
            sort: { column: "engagement", order: "desc" },
            columns: ["email", "status", "rating"],
            reset: { page: 1, selection: "clear" },
          },
        },
      },
      expect.objectContaining({ maxAttempts: 1, requireOnline: true }),
    );
    expect(mocks.toast.success).toHaveBeenCalledWith("Saved view “Cold unconfirmed”.");
  });

  it("blocks a duplicate name before sending anything", async () => {
    const dialog = await openSaved();
    type(field("Save the current view as", dialog), "churn RISKS");
    expect(button("Save view", dialog).disabled).toBe(true);
    expect(dialog.textContent).toContain("A saved view with this name already exists.");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("deletes a saved view only through a confirm that names who loses it", async () => {
    await openSaved();
    click(button("Delete saved view Churn risks"));
    await flush();
    const confirm = topDialog();
    expect(confirm.textContent).toContain("Delete saved view “Churn risks”?");
    expect(confirm.textContent).toContain(
      "Everyone in the workspace loses this view. Subscribers are not changed.",
    );
    expect(mocks.del).not.toHaveBeenCalled();
    click(button("Delete view", confirm));
    await flush();
    expect(mocks.del).toHaveBeenCalledWith(
      "/api/v1/segments/saved/sv_v3",
      expect.objectContaining({ maxAttempts: 1, requireOnline: true }),
    );
  });

  it("lets a viewer apply views but withholds save and delete with the reason", async () => {
    mocks.whoami.mockResolvedValue(VIEWER);
    const dialog = await openSaved();
    expect((field("Save the current view as", dialog) as HTMLInputElement).disabled).toBe(true);
    expect(button("Save view", dialog).disabled).toBe(true);
    expect(dialog.textContent).toContain("Viewers can apply saved views but cannot create them.");
    expect(queryButton("Delete saved view Churn risks")).toBeNull();
    expect(button("Apply", dialog).disabled).toBe(false);
  });
});

describe("saved-view predicate round trip", () => {
  it("reads back exactly the view it writes, and desktop's legacy shapes", () => {
    const view = {
      q: "acme",
      status: "disabled" as const,
      archived: true,
      sort: "created_at" as const,
      order: "asc" as const,
    };
    const predicate = directoryViewPredicate(view, ["email", "tags"]);
    expect(directoryViewFromPredicate(predicate)).toEqual({
      view,
      columns: ["email", "tags"],
    });
    expect(directoryViewFromPredicate({ status: "unconfirmed", q: "x" }).view).toMatchObject({
      status: "pending",
      q: "x",
    });
    const tampered = JSON.parse(JSON.stringify(predicate));
    tampered.snapshot.columns = ["tags"];
    expect(directoryViewFromPredicate(tampered).view).toBeNull();
  });
});

describe("live additions (audience-14)", () => {
  it("counts subscriber.added events since the view opened and flushes to newest-first", async () => {
    mountToolbar("status=disabled&page=2");
    await flush();
    expect(mocks.bus.options).toEqual({ topics: ["subscriber.added"], recover: false });
    expect(document.body.textContent).not.toContain("joined since this view was opened");

    const emit = mocks.bus.handler;
    if (!emit) throw new Error("realtime bus not connected");
    act(() => {
      emit({ topic: "subscriber.added", payload: { id: "a" } });
      emit({ topic: "subscriber.added", payload: { id: "a" } });
      emit({ topic: "subscriber.updated", payload: { id: "c" } });
      emit({ topic: "subscriber.added", payload: { id: "b" } });
    });
    await flush();
    expect(document.body.textContent).toContain(
      "2 subscribers joined since this view was opened.",
    );

    const listReads = getCalls("/api/v1/subscribers").length;
    click(button("Show newest"));
    await flush();
    expect(navStore.params().get("sort")).toBe("created_at");
    expect(navStore.params().get("status")).toBeNull();
    expect(navStore.params().get("page")).toBeNull();
    expect(getCalls("/api/v1/subscribers").length).toBeGreaterThan(listReads);
    expect(document.body.textContent).not.toContain("joined since this view was opened");
  });
});

describe("lookalike generation (audience-32)", () => {
  async function openLookalike() {
    mountToolbar();
    await flush();
    click(button("Lookalike"));
    await flush();
    return topDialog();
  }

  it("generates from an evaluated seed, records a destination and deletes a model", async () => {
    const dialog = await openLookalike();
    const seed = field("Seed segment", dialog) as HTMLSelectElement;
    expect([...seed.options].map((option) => option.textContent)).toEqual([
      "Choose a seed segment…",
      "VIPs (120)",
    ]);
    type(seed, SEG);
    type(field("Audience size", dialog), "500");
    type(field("Confidence floor", dialog), "0.9");
    const generate = button("Generate lookalike", dialog);
    expect(generate.disabled).toBe(true); // acknowledgement not given yet
    click(field(/^I confirm this workspace may use/, dialog) as HTMLInputElement);
    click(button("Generate lookalike", dialog));
    await flush();

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/subscribers/lookalike",
      {
        name: "Lookalike audience",
        seed_segment_id: SEG,
        size: 500,
        confidence_threshold: 0.9,
        data_use_acknowledged: true,
      },
      expect.objectContaining({ maxAttempts: 1, requireOnline: true, timeoutMs: 60_000 }),
    );
    expect(dialog.textContent).toContain("Ready · 480 of 500 modeled from 120 seed members");

    const destination = field("Export destination", dialog) as HTMLSelectElement;
    expect([...destination.options].map((option) => option.value)).toEqual(["", DEST]);
    type(destination, DEST);
    click(button("Export", dialog));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      `/api/v1/subscribers/lookalike/${LOOKALIKE}/export`,
      { destination_id: DEST },
      expect.objectContaining({ maxAttempts: 1 }),
    );
    expect(dialog.textContent).toContain("Destination recorded: meta.");

    click(button("Delete modeled audience Older model", dialog));
    await flush();
    const confirm = topDialog();
    expect(confirm.textContent).toContain(
      "The modeled audience and its member scores are deleted. Seed segments and subscribers are not changed.",
    );
    click(button("Delete audience", confirm));
    await flush();
    expect(mocks.del).toHaveBeenCalledWith(
      "/api/v1/subscribers/lookalike/77777777-7777-4777-8777-777777777777",
      expect.objectContaining({ maxAttempts: 1 }),
    );
  });

  it("withholds generation from a viewer with the reason", async () => {
    mocks.whoami.mockResolvedValue(VIEWER);
    const dialog = await openLookalike();
    expect(button("Generate lookalike", dialog).disabled).toBe(true);
    expect(dialog.textContent).toContain(
      "Generating a lookalike needs an owner, admin or editor role.",
    );
    expect(queryButton("Delete modeled audience Older model")).toBeNull();
  });

  it("polls a still-running model until it reaches a terminal state", async () => {
    let reads = 0;
    mocks.get.mockImplementation(async (path) => {
      if (path === `/api/v1/subscribers/lookalike/${LOOKALIKE}`) {
        reads += 1;
        return { audience: audience({ status: reads < 2 ? "running" : "ready" }) };
      }
      return routeGet(path);
    });
    const start = {
      id: LOOKALIKE,
      status: "pending",
    } as unknown as LookalikeAudience;
    const done = await waitForLookalikeTerminal(start, { intervalMs: 0 });
    expect(done.status).toBe("ready");
    expect(reads).toBe(2);
    expect(mocks.get).toHaveBeenCalledWith(`/api/v1/subscribers/lookalike/${LOOKALIKE}`, {
      query: { per_page: 1 },
      signal: undefined,
    });
  });
});

describe("directory keyboard commands hook (audience-10)", () => {
  function Rows(props: {
    onToggleRow: (index: number) => void;
    onOpenRow: (index: number) => void;
    onNew: () => void;
    onSelectPage: () => void;
    onExport: () => void;
  }) {
    const keys = useDirectoryKeyboardShortcuts({ rowCount: 3, ...props });
    return createElement(
      "ul",
      null,
      [0, 1, 2].map((index) =>
        createElement(
          "li",
          {
            key: index,
            tabIndex: -1,
            "data-subscriber-row-index": index,
            "data-focused": keys.focusedIndex === index ? "yes" : "no",
            onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => keys.rowKeyDown(event, index),
          },
          `row ${index}`,
        ),
      ),
    );
  }

  function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  function row(index: number): HTMLElement {
    const element = document.querySelector<HTMLElement>(`[data-subscriber-row-index="${index}"]`);
    if (!element) throw new Error(`row ${index} missing`);
    return element;
  }

  it("moves, selects, opens, creates, selects the page and exports from the keyboard", async () => {
    const handlers = {
      onToggleRow: vi.fn(),
      onOpenRow: vi.fn(),
      onNew: vi.fn(),
      onSelectPage: vi.fn(),
      onExport: vi.fn(),
    };
    render(createElement(Rows, handlers));
    await flush(1);

    press("j");
    press("j");
    await flush(1);
    expect(row(1).dataset.focused).toBe("yes");
    expect(document.activeElement).toBe(row(1));
    press("k");
    await flush(1);
    expect(document.activeElement).toBe(row(0));

    press("x");
    expect(handlers.onToggleRow).toHaveBeenCalledWith(0);
    press("Enter");
    expect(handlers.onOpenRow).toHaveBeenCalledWith(0);
    press("n");
    expect(handlers.onNew).toHaveBeenCalledTimes(1);
    const selectAll = press("a", { ctrlKey: true });
    expect(handlers.onSelectPage).toHaveBeenCalledTimes(1);
    expect(selectAll.defaultPrevented).toBe(true);
    press("e", { metaKey: true });
    expect(handlers.onExport).toHaveBeenCalledTimes(1);

    press("End", {}, row(0));
    await flush(1);
    expect(document.activeElement).toBe(row(2));
    press("ArrowUp", {}, row(2));
    await flush(1);
    expect(document.activeElement).toBe(row(1));
    press("Home", {}, row(1));
    await flush(1);
    expect(document.activeElement).toBe(row(0));
  });

  it("stands down while typing or while a dialog owns the keyboard", async () => {
    const handlers = {
      onToggleRow: vi.fn(),
      onOpenRow: vi.fn(),
      onNew: vi.fn(),
      onSelectPage: vi.fn(),
      onExport: vi.fn(),
    };
    render(createElement(Rows, handlers));
    await flush(1);
    const input = document.createElement("input");
    document.body.append(input);
    press("n", {}, input);
    const typedSelectAll = press("a", { ctrlKey: true }, input);
    expect(handlers.onNew).not.toHaveBeenCalled();
    expect(handlers.onSelectPage).not.toHaveBeenCalled();
    expect(typedSelectAll.defaultPrevented).toBe(false);

    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    document.body.append(modal);
    press("n");
    press("j");
    expect(handlers.onNew).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(row(0));
  });
});

describe("keyboard (audience-10)", () => {
  it("focuses the search box on / from anywhere, but not while typing", async () => {
    navStore.set("");
    render(
      createElement(SubscribersSearchForm, {
        appliedQuery: "",
        onSearch: () => undefined,
        onClear: () => undefined,
      }),
    );
    await flush();
    const search = byAriaLabel<HTMLInputElement>("Search subscribers");
    expect(document.activeElement).not.toBe(search);

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    });
    expect(document.activeElement).toBe(search);

    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    const typed = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    act(() => {
      other.dispatchEvent(typed);
    });
    expect(document.activeElement).toBe(other);
    expect(typed.defaultPrevented).toBe(false);
  });
});
