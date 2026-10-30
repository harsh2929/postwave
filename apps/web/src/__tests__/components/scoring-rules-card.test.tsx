// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Parity row audience-45 — the lead-scoring rules editor on /scoring.
//
// The save REPLACES THE WHOLE RULE SET and is version-bound, so the PUT body
// (every row, in the wire shape, plus the version the draft was started from)
// is asserted exactly, and so is what happens when another administrator got
// there first: 409, nothing overwritten, draft kept, refresh re-pins it.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => ({})),
  put: vi.fn(
    async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> =>
      ({}),
  ),
  whoamiFresh: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { get: mocks.get, put: mocks.put },
  apiErrorMessage: (error: unknown, fallback = "Something went wrong") =>
    error instanceof Error && error.message ? error.message : fallback,
  isApiError: (error: unknown) =>
    error instanceof Error && typeof (error as { status?: unknown }).status === "number",
}));
vi.mock("@/lib/auth-api", () => ({
  whoami: vi.fn(),
  whoamiFresh: mocks.whoamiFresh,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { ScoringRulesCard } from "@/components/subscribers/ScoringRulesCard";
import type { MeResponse } from "@/lib/auth-api";
import { effectiveWeights, type ScoringConfig } from "@/lib/scoring-taxonomy-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "ada@example.com",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
} as unknown as MeResponse;
const EDITOR = {
  ...OWNER,
  role: "editor",
  effective_role: "editor",
} as unknown as MeResponse;

const V1 = `sha256:${"a".repeat(64)}`;
const V2 = `sha256:${"b".repeat(64)}`;
const V3 = `sha256:${"c".repeat(64)}`;
const KEY = ["scoring-taxonomy", OWNER.tenant_id, "owner", "scoring"] as const;

function rulesResponse(version: string) {
  return {
    rules: [
      { id: "r1", event_type: "clicked", weight: 3, note: "clicks matter" },
      { id: "r2", event_type: "opened", weight: 1 },
    ],
    defaults: [
      { id: "", event_type: "clicked", weight: 5 },
      { id: "", event_type: "opened", weight: 1 },
      { id: "", event_type: "unsubscribed", weight: -10 },
    ],
    event_catalog: [
      { event_type: "clicked", label: "Clicked", category: "engagement" },
      { event_type: "opened", label: "Opened", category: "engagement" },
      { event_type: "unsubscribed", label: "Unsubscribed", category: "consent" },
    ],
    version,
    window_days: 90,
  };
}

const roots: Root[] = [];
let client: QueryClient;

function render(ui: ReactNode): Root {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  roots.push(root);
  return root;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(identity: MeResponse = OWNER) {
  return render(createElement(ScoringRulesCard, { identity, queryKey: KEY }));
}

function editor(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    '[data-testid="scoring-rules-editor"]',
  );
  if (!element) throw new Error("Scoring editor not rendered");
  return element;
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function control<T extends HTMLElement>(label: string): T {
  const element = document.querySelector<T>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`Control not found: ${label}`);
  return element;
}

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!element) throw new Error("No dialog is open");
  return element;
}

function type(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto =
    element instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoamiFresh.mockResolvedValue(OWNER);
  mocks.get.mockResolvedValue(rulesResponse(V1));
  mocks.put.mockImplementation(async (_path: string, body?: unknown) => ({
    saved: (body as { rules: unknown[] }).rules.length,
    version: V3,
  }));
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

describe("lead-scoring rules editor", () => {
  it("loads the saved rules as editable rows", async () => {
    mount();
    await flush();

    expect(mocks.get).toHaveBeenCalledWith("/api/v1/scoring/rules");
    expect(control<HTMLSelectElement>("Rule 1 event type").value).toBe("clicked");
    expect(control<HTMLInputElement>("Rule 1 weight").value).toBe("3");
    expect(control<HTMLInputElement>("Rule 1 note").value).toBe("clicks matter");
    expect(button("Review changes").disabled).toBe(true);
  });

  it("saves a reviewed whole-set replacement pinned to the loaded version", async () => {
    mount();
    await flush();

    act(() => type(control<HTMLInputElement>("Rule 2 weight"), "2"));
    act(() => button("Add rule").click());
    act(() => type(control<HTMLSelectElement>("Rule 3 event type"), "unsubscribed"));
    act(() => type(control<HTMLInputElement>("Rule 3 weight"), "-20"));
    act(() => type(control<HTMLInputElement>("Rule 3 note"), "  opt-outs cost "));
    act(() => button("Review changes").click());
    await flush();

    expect(dialog().textContent).toContain(
      "This version-bound save adds 1, changes 1, and removes 0 rules.",
    );
    expect(mocks.put).not.toHaveBeenCalled();

    await act(async () => {
      button("Save reviewed rule set", dialog()).click();
    });
    await flush();

    expect(mocks.whoamiFresh).toHaveBeenCalled();
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/v1/scoring/rules",
      {
        rules: [
          { event_type: "clicked", weight: 3, note: "clicks matter" },
          { event_type: "opened", weight: 2 },
          { event_type: "unsubscribed", weight: -20, note: "opt-outs cost" },
        ],
        expected_version: V1,
      },
      { requireOnline: true },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Saved 3 scoring rules. Changed scores refresh automatically within 15 minutes.",
    );
  });

  it("says a save that removes every rule hands scoring back to the defaults", async () => {
    mount();
    await flush();

    act(() => button("Remove rule 2").click());
    act(() => button("Remove rule 1").click());
    act(() => button("Review changes").click());
    await flush();

    expect(dialog().textContent).toContain(
      "removes 2 rules. Removing every custom rule switches the workspace back to the published default weights.",
    );
    await act(async () => {
      button("Save reviewed rule set", dialog()).click();
    });
    await flush();
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/v1/scoring/rules",
      { rules: [], expected_version: V1 },
      { requireOnline: true },
    );
  });

  it("refuses a blank weight before opening the review", async () => {
    mount();
    await flush();

    act(() => type(control<HTMLInputElement>("Rule 1 weight"), ""));
    act(() => button("Review changes").click());
    await flush();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(editor().textContent).toContain("Weight must be a whole number.");
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("keeps the draft on a 409 and re-pins it to the server version on refresh", async () => {
    mount();
    await flush();

    act(() => type(control<HTMLInputElement>("Rule 1 weight"), "7"));
    // A background refetch lands a newer version; the draft stays pinned to V1.
    mocks.get.mockResolvedValue(rulesResponse(V2));
    await act(async () => {
      await client.refetchQueries({ queryKey: [...KEY] });
    });
    await flush();

    mocks.put.mockRejectedValueOnce(
      new FakeApiError(
        "Scoring rules changed after this draft loaded. Refresh and review the current rule set before saving again.",
        409,
      ),
    );
    act(() => button("Review changes").click());
    await flush();
    await act(async () => {
      button("Save reviewed rule set", dialog()).click();
    });
    await flush();

    expect(mocks.put).toHaveBeenLastCalledWith(
      "/api/v1/scoring/rules",
      expect.objectContaining({ expected_version: V1 }),
      { requireOnline: true },
    );
    expect(editor().textContent).toContain(
      "Scoring rules changed after this draft loaded.",
    );
    expect(control<HTMLInputElement>("Rule 1 weight").value).toBe("7");

    act(() => button("Refresh rules").click());
    await flush();
    expect(dialog().textContent).toContain(
      "This loads the current server version while preserving your local draft.",
    );
    await act(async () => {
      button("Keep draft and refresh", dialog()).click();
    });
    await flush();
    expect(control<HTMLInputElement>("Rule 1 weight").value).toBe("7");

    act(() => button("Review changes").click());
    await flush();
    await act(async () => {
      button("Save reviewed rule set", dialog()).click();
    });
    await flush();
    expect(mocks.put).toHaveBeenLastCalledWith(
      "/api/v1/scoring/rules",
      expect.objectContaining({ expected_version: V2 }),
      { requireOnline: true },
    );
  });

  it("shows a non-admin the rules read-only, with the reason", async () => {
    mount(EDITOR);
    await flush();

    expect(control<HTMLInputElement>("Rule 1 weight").disabled).toBe(true);
    expect(button("Add rule").disabled).toBe(true);
    expect(button("Review changes").disabled).toBe(true);
    expect(editor().textContent).toContain(
      "Lead-scoring rules need owner or admin access to change.",
    );
  });
});

describe("effective weights", () => {
  it("uses the custom rules alone once any exist — defaults are not merged in", () => {
    const config = {
      ...rulesResponse(V1),
      rules: [{ id: "r1", event_type: "clicked", weight: 3 }],
    } as ScoringConfig;
    expect(effectiveWeights(config)).toEqual([
      { id: "r1", event_type: "clicked", weight: 3 },
    ]);
    expect(effectiveWeights({ ...config, rules: [] })).toHaveLength(3);
  });
});
