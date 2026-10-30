// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The segment builder, mounted for real against the API's recorded responses
// (src/__tests__/fixtures/segments, captured from the Go handlers on this
// branch). Three defects are pinned:
//
//   * The Field dropdown merged the registry with GET /custom-fields and a
//     hard-coded "Built-in" group, so custom fields appeared twice, the
//     `custom.*` descriptor appeared as a field that matches nothing, and
//     groups were headed "custom_field" / "profile".
//   * Registry predicates got the comparators of their collapsed kind, so
//     "Member of segment" offered "equals" and a text box, and saving answered
//     400 bad_ast.
//   * Create returned to the list (which then waited on a server render) and
//     re-enabled the button, instead of landing on the new segment.
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Segment } from "@/lib/segments-api";

import registry from "../fixtures/segments/predicate-registry.json";
import created from "../fixtures/segments/segment-create-201.json";
import { waitFor } from "../pages/_wait";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.push,
    replace: vi.fn(),
    refresh: mocks.refresh,
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/subscribers/segments/new",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    message: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue({
    user_id: "11111111-1111-4111-8111-111111111111",
    tenant_id: created.tenantId,
    email: "owner@example.test",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
  }),
}));

// Another saved segment a segment-of-segments rule can point at.
const REFERENCE = {
  ...created,
  id: "7c2d1c43-0a0e-4b8e-9d7f-1b2c3d4e5f60",
  name: "Engaged readers",
};

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

let requests: Recorded[] = [];
let registryStatus = 200;
// When set, the registry answers only once it resolves.
let registryGate: Promise<void> | null = null;
let segmentsStatus = 200;
let usageItems: unknown[] | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  requests = [];
  registryStatus = 200;
  registryGate = null;
  segmentsStatus = 200;
  usageItems = null;
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
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ method, path: url.pathname, body });
      if (url.pathname === "/api/v1/segments/predicate-registry") {
        if (registryGate) await registryGate;
        return registryStatus === 200
          ? json(registry)
          : json(
              {
                error: {
                  code: "internal_error",
                  message: "an internal error occurred",
                },
              },
              registryStatus,
            );
      }
      if (url.pathname === "/api/v1/custom-fields") {
        return json([
          { id: "cf-1", key: "plan", label: "Plan", type: "string" },
        ]);
      }
      if (url.pathname === "/api/v1/segments" && method === "GET") {
        return segmentsStatus === 200
          ? json([REFERENCE])
          : json(
              {
                error: {
                  code: "internal_error",
                  message: "an internal error occurred",
                },
              },
              segmentsStatus,
            );
      }
      if (url.pathname.endsWith("/usage") && usageItems) {
        return json({ items: usageItems, count: usageItems.length });
      }
      if (url.pathname === "/api/v1/segments" && method === "POST") {
        return json(created, 201);
      }
      return json({ error: { code: "not_found", message: "" } }, 404);
    }),
  );
  window.history.replaceState({}, "", "/app/subscribers/segments/new");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

async function flush(turns = 8) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountEditor(
  initial?: Segment,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  }),
) {
  const { SegmentEditor } =
    await import("@/components/segments/segment-editor");
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const host = document.createElement("div");
  document.body.appendChild(host);
  let root!: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SegmentEditor, { initial }),
      ),
    );
  });
  await flush();
  return { host, root, invalidate };
}

function fieldSelect(host: HTMLElement): HTMLSelectElement {
  const select = host.querySelector<HTMLSelectElement>(
    'select[aria-label="Field"]',
  );
  if (!select) throw new Error("Field select not found");
  return select;
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush(2);
}

async function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
  await act(async () => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function createButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Create segment",
  );
  if (!button) throw new Error("Create segment button not found");
  return button as HTMLButtonElement;
}

function postedSegment(): { queryAst: unknown; name: string } {
  const post = requests.find(
    (r) => r.method === "POST" && r.path === "/api/v1/segments",
  );
  if (!post) throw new Error("no POST /api/v1/segments was sent");
  return post.body as { queryAst: unknown; name: string };
}

describe("segment builder field catalogue", () => {
  it("offers each field once, under headings people read", async () => {
    const { host, root } = await mountEditor();
    try {
      const select = fieldSelect(host);
      const values = [...select.options].map((o) => o.value);
      expect(new Set(values).size).toBe(values.length);
      expect(values).not.toContain("custom.*");
      expect(values).not.toContain("object.order.exists"); // planned
      expect(values).toContain("segment_id");
      expect(values).toContain("metric.track.placed_order.count");

      const groups = [...select.querySelectorAll("optgroup")].map(
        (g) => g.label,
      );
      expect(groups).not.toContain("Built-in");
      for (const label of groups) expect(label).not.toMatch(/^[a-z_]+$/);
      expect(groups).toEqual(
        expect.arrayContaining([
          "Profile",
          "Consent",
          "Engagement",
          "Custom fields",
          "Segments",
          "Predictive & RFM",
          "Events",
        ]),
      );

      const plans = [...select.options].filter((o) => o.textContent === "Plan");
      expect(plans).toHaveLength(1);
      expect((plans[0]!.parentElement as HTMLOptGroupElement).label).toBe(
        "Custom fields",
      );
      // The registry already lists custom fields; the separate list is only a
      // fallback and is not fetched when the registry answers.
      expect(requests.some((r) => r.path === "/api/v1/custom-fields")).toBe(
        false,
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("falls back to the basic fields, and says so, when the registry fails", async () => {
    registryStatus = 500;
    const { host, root } = await mountEditor();
    try {
      // A 500 is retried with backoff before the fallback applies.
      const findAlert = () =>
        [...host.querySelectorAll('[role="alert"]')].find((a) =>
          a.textContent?.includes("Couldn't load the full list of fields"),
        );
      const deadline = Date.now() + 8_000;
      while (!findAlert() && Date.now() < deadline) await flush(1);
      const alert = findAlert();
      expect(alert).toBeTruthy();
      expect(alert?.querySelector("button")?.textContent).toBe("Retry");
      const values = [...fieldSelect(host).options].map((o) => o.value);
      expect(values).toEqual(
        expect.arrayContaining(["email", "status", "tag", "custom.plan"]),
      );
      expect(values).not.toContain("segment_id");
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("segment builder comparators and values follow the field", () => {
  it("'Member of segment' offers only is in / is not in and picks a segment by name", async () => {
    const { host, root } = await mountEditor();
    try {
      await choose(fieldSelect(host), "segment_id");
      const comparator = host.querySelector<HTMLSelectElement>(
        'select[aria-label="Comparator"]',
      )!;
      expect(
        [...comparator.options].map((o) => [o.value, o.textContent]),
      ).toEqual([
        ["in_segment", "is in"],
        ["not_in_segment", "is not in"],
      ]);
      const segment = host.querySelector<HTMLSelectElement>(
        'select[aria-label="Segment"]',
      );
      expect(segment).not.toBeNull();
      const names = [...segment!.options]
        .filter((o) => !o.disabled)
        .map((o) => o.textContent);
      expect(names).toEqual(["Engaged readers"]);
      await choose(segment!, REFERENCE.id);

      await type(
        host.querySelector<HTMLInputElement>("#seg-name")!,
        "Engaged and recent",
      );
      await act(async () => createButton(host).click());
      await flush();

      expect(postedSegment().queryAst).toEqual({
        op: "and",
        children: [
          {
            op: "condition",
            field: "segment_id",
            comparator: "in_segment",
            value: REFERENCE.id,
          },
        ],
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("engagement dates use the rolling-window vocabulary with a day count", async () => {
    const { host, root } = await mountEditor();
    try {
      await choose(fieldSelect(host), "last_opened_at");
      const comparator = host.querySelector<HTMLSelectElement>(
        'select[aria-label="Comparator"]',
      )!;
      expect([...comparator.options].map((o) => o.value)).toEqual([
        "in_last_days",
        "more_than_days_ago",
        "ever",
        "never",
      ]);
      const days = host.querySelector<HTMLInputElement>(
        'input[aria-label="Days"]',
      )!;
      expect(days.value).toBe("30");
      await type(days, "14");
      await type(
        host.querySelector<HTMLInputElement>("#seg-name")!,
        "Opened lately",
      );
      await act(async () => createButton(host).click());
      await flush();
      expect(postedSegment().queryAst).toEqual({
        op: "and",
        children: [
          {
            op: "condition",
            field: "last_opened_at",
            comparator: "in_last_days",
            value: 14,
          },
        ],
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("switching to a tag-history comparator asks for a tag and a window", async () => {
    const { host, root } = await mountEditor();
    try {
      await choose(fieldSelect(host), "tags");
      await choose(
        host.querySelector<HTMLSelectElement>(
          'select[aria-label="Comparator"]',
        )!,
        "added_in_last_days",
      );
      await type(
        host.querySelector<HTMLInputElement>('input[aria-label="Tag name"]')!,
        "vip",
      );
      await type(
        host.querySelector<HTMLInputElement>("#seg-name")!,
        "New VIPs",
      );
      await act(async () => createButton(host).click());
      await flush();
      expect(postedSegment().queryAst).toEqual({
        op: "and",
        children: [
          {
            op: "condition",
            field: "tags",
            comparator: "added_in_last_days",
            value: { tag: "vip", days: 30 },
          },
        ],
      });
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("event-count rules", () => {
  it("name the event as tracked, not the slug in the field key", async () => {
    // The recorded registry tracks "Placed Order" under the key
    // metric.track.placed_order.count; the compiler counts events whose name
    // equals the slug unless the value names the event.
    const { host, root } = await mountEditor();
    try {
      await choose(fieldSelect(host), "metric.track.placed_order.count");
      await choose(
        host.querySelector<HTMLSelectElement>(
          'select[aria-label="Comparator"]',
        )!,
        "gte",
      );
      await type(
        host.querySelector<HTMLInputElement>('input[aria-label="Count"]')!,
        "2",
      );
      await type(
        host.querySelector<HTMLInputElement>("#seg-name")!,
        "Repeat buyers",
      );
      await act(async () => createButton(host).click());
      await flush();
      expect(postedSegment().queryAst).toEqual({
        op: "and",
        children: [
          {
            op: "condition",
            field: "metric.track.placed_order.count",
            comparator: "gte",
            value: { count: 2, event_name: "Placed Order" },
          },
        ],
      });
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("rules saved before the registry vocabulary", () => {
  it("an engagement rule with an ordered comparator still edits as a date", async () => {
    const legacy = {
      ...created,
      queryAst: {
        op: "and",
        children: [
          {
            op: "condition",
            field: "last_opened_at",
            comparator: "gte",
            value: "now-30d",
          },
        ],
      },
    } as Segment;
    const { host, root } = await mountEditor(legacy);
    try {
      const comparator = host.querySelector<HTMLSelectElement>(
        'select[aria-label="Comparator"]',
      )!;
      // Shown as stored, labelled as a date comparison, not a raw token.
      expect(comparator.value).toBe("gte");
      expect(comparator.selectedOptions[0]?.textContent).toBe("on or after");
      // The relative-date control, not a text box holding "now-30d".
      const relative = [
        ...host.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
      ].find((b) => b.textContent === "Relative");
      expect(relative?.getAttribute("aria-checked")).toBe("true");
      expect(
        host.querySelector<HTMLInputElement>('input[aria-label="Days"]')?.value,
      ).toBe("30");
      expect(host.querySelector('input[aria-label="Value"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("creating a segment", () => {
  it("lands on the new segment, refreshes the segment caches, and does not re-arm Create", async () => {
    const { host, root, invalidate } = await mountEditor();
    try {
      await type(
        host.querySelector<HTMLInputElement>("#seg-name")!,
        created.name,
      );
      await type(
        host.querySelector<HTMLInputElement>('input[aria-label="Value"]')!,
        "@example.test",
      );
      await act(async () => createButton(host).click());
      await flush();

      expect(mocks.push).toHaveBeenCalledWith(
        `/app/subscribers/segments/${created.id}`,
      );
      expect(mocks.refresh).not.toHaveBeenCalled();
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Segment created.");
      expect(createButton(host).disabled).toBe(true);
      const predicate = invalidate.mock.calls[0]?.[0]?.predicate;
      expect(typeof predicate).toBe("function");
      const matches = (queryKey: unknown[]) =>
        predicate!({ queryKey } as never);
      expect(matches(["segments", created.tenantId, "owner", null])).toBe(true);
      expect(
        matches(["segment", created.tenantId, "owner", "p", created.id]),
      ).toBe(true);
      expect(matches(["segments", "someone-else", "owner", null])).toBe(false);
      expect(matches(["campaigns", created.tenantId, "owner"])).toBe(false);
      // The overview's panels are computed from the definition as well.
      for (const resource of [
        "segment-engagement",
        "segment-decay",
        "segment-pnl",
      ]) {
        expect(
          matches([resource, created.tenantId, "owner", "p", created.id]),
        ).toBe(true);
      }
    } finally {
      act(() => root.unmount());
    }
  });
});

/** An existing segment whose one rule is a registry-only field. */
function storedWith(
  field: string,
  comparator: string,
  value: unknown,
): Segment {
  return {
    ...(created as unknown as Segment),
    queryAst: {
      op: "and",
      children: [{ op: "condition", field, comparator, value }],
    },
  } as Segment;
}

async function until(check: () => boolean, ms = 8_000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await flush(1);
  return check();
}

function fieldListAlert(host: HTMLElement) {
  return [...host.querySelectorAll('[role="alert"]')].find((a) =>
    a.textContent?.includes("Couldn't load the full list of fields"),
  );
}

describe("the field catalogue while it loads, fails and recovers", () => {
  it("shows no rule until the fields arrive, so stored fields are never called gone", async () => {
    let open!: () => void;
    registryGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { host, root } = await mountEditor(
      storedWith("metric.track.placed_order.count", "gte", { count: 2 }),
    );
    try {
      expect(host.querySelector('select[aria-label="Field"]')).toBeNull();
      const status = [...host.querySelectorAll('[role="status"]')].find((el) =>
        el.textContent?.includes("Loading fields"),
      );
      expect(status).toBeTruthy();
      expect(host.textContent).not.toContain("no longer available");

      await act(async () => open());
      await flush();
      const select = fieldSelect(host);
      expect(select.value).toBe("metric.track.placed_order.count");
      expect(select.selectedOptions[0]?.textContent).toBe("Placed Order count");
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not call a stored field gone when only the field list failed", async () => {
    registryStatus = 500;
    const { host, root } = await mountEditor(
      storedWith("metric.track.placed_order.count", "gte", { count: 2 }),
    );
    try {
      expect(await until(() => Boolean(fieldListAlert(host)))).toBe(true);
      const label = fieldSelect(host).selectedOptions[0]?.textContent ?? "";
      expect(label).toContain(
        "can't show this field until the field list loads",
      );
      expect(label).not.toContain("no longer available");
    } finally {
      act(() => root.unmount());
    }
  });

  it("asks the registry again on the next visit instead of keeping the fallback for a day", async () => {
    registryStatus = 500;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } },
    });
    const first = await mountEditor(undefined, client);
    expect(await until(() => Boolean(fieldListAlert(first.host)))).toBe(true);
    act(() => first.root.unmount());

    registryStatus = 200;
    const second = await mountEditor(undefined, client);
    try {
      expect(
        await until(() =>
          [...fieldSelect(second.host).options].some(
            (o) => o.value === "segment_id",
          ),
        ),
      ).toBe(true);
      expect(fieldListAlert(second.host)).toBeUndefined();
    } finally {
      act(() => second.root.unmount());
    }
  });
});

describe("picking a segment when the segment list can't load", () => {
  it("says so and offers Retry instead of claiming there are no segments", async () => {
    segmentsStatus = 500;
    const { host, root } = await mountEditor();
    try {
      await choose(fieldSelect(host), "segment_id");
      const segmentSelect = () =>
        host.querySelector<HTMLSelectElement>('select[aria-label="Segment"]')!;
      expect(
        await until(() =>
          (segmentSelect().options[0]?.textContent ?? "").includes(
            "Couldn't load your segments",
          ),
        ),
      ).toBe(true);
      expect(host.textContent).not.toContain("No other segments yet");
      const retry = host.querySelector<HTMLButtonElement>(
        'button[aria-label="Retry loading segments"]',
      );
      expect(retry).toBeTruthy();

      segmentsStatus = 200;
      await act(async () => retry!.click());
      expect(
        await until(() =>
          [...segmentSelect().options].some(
            (o) => o.textContent === "Engaged readers",
          ),
        ),
      ).toBe(true);
      expect(segmentSelect().disabled).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("deleting a segment a campaign still depends on", () => {
  async function openDeleteDialog(host: HTMLElement) {
    const trigger = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Delete",
    );
    if (!trigger) throw new Error("Delete button not found");
    await act(async () => trigger.click());
    // The confirmation loads on its first open (DeferredConfirmDialog).
    const openDialog = () => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      if (!dialog) throw new Error("delete dialog did not open");
      return dialog;
    };
    await waitFor(() => void openDialog());
    return openDialog();
  }
  const buttonIn = (dialog: HTMLElement, text: string) =>
    [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined;

  it("explains what to move and offers no delete that can only be refused", async () => {
    usageItems = [
      {
        kind: "campaign",
        id: "c1",
        name: "Spring launch",
        status: "draft",
        blocks_delete: true,
      },
    ];
    const { host, root } = await mountEditor(created as unknown as Segment);
    try {
      const dialog = await openDeleteDialog(host);
      expect(dialog.textContent).toContain("This segment can't be deleted yet");
      expect(dialog.textContent).toContain('"Spring launch"');
      expect(buttonIn(dialog, "Delete")?.disabled).toBe(true);
      expect(buttonIn(dialog, "Close")).toBeTruthy();
      expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("offers the delete when the only campaign already began sending", async () => {
    usageItems = [
      {
        kind: "campaign",
        id: "c2",
        name: "Paused mid-send",
        status: "paused",
        blocks_delete: false,
      },
    ];
    const { host, root } = await mountEditor(created as unknown as Segment);
    try {
      const dialog = await openDeleteDialog(host);
      expect(dialog.textContent).toContain("Delete segment?");
      expect(dialog.textContent).not.toContain("Paused mid-send");
      expect(buttonIn(dialog, "Delete")?.disabled).toBe(false);
      expect(buttonIn(dialog, "Cancel")).toBeTruthy();
    } finally {
      act(() => root.unmount());
    }
  });
});
