// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Parity row campaigns-34 — pre-send audience refinement (server SUB-067).
//
// The hazard this suite exists for: preview and commit are the SAME endpoint
// and `dry_run` is the only difference. So the assertions are about the BODY
// each control sends, not about the panel rendering. A preview that ever went
// out with `dry_run: false` would silently exclude subscribers from a send
// nobody approved.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { get: mocks.get, post: mocks.post, delete: mocks.del },
  apiErrorMessage: (error: unknown, fallback = "Something went wrong") =>
    error instanceof Error && error.message ? error.message : fallback,
  ApiError: class ApiError extends Error {
    status = 0;
  },
}));
vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { PreSendRefinePanel } from "@/components/campaigns/presend-refine-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN = "33333333-3333-4333-8333-333333333333";
const REFINE_PATH = `/api/v1/campaigns/${CAMPAIGN}/presend-refine`;

const OWNER = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: TENANT,
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
};
const VIEWER = { ...OWNER, role: "viewer", effective_role: "viewer" };

const SAVED = {
  campaign_id: CAMPAIGN,
  churn_threshold: 80,
  cooling_off_hours: 24,
  excluded_count: 12,
  cooling_off_count: 12,
  cooling_off_until: "2026-09-06T12:00:00Z",
  dry_run: false,
  exclude_recently_paused: false,
  affected_subscribers_sample: [],
};
const PREVIEW = {
  ...SAVED,
  excluded_count: 40,
  cooling_off_count: 40,
  dry_run: true,
  affected_subscribers_sample: [
    {
      subscriber_id: "s1",
      email: "churny@example.com",
      churn_score: 97,
      reason: "churn_risk",
    },
  ],
};

const roots: Root[] = [];

function render(ui: ReactNode): Root {
  const client = new QueryClient({
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
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount() {
  return render(
    createElement(PreSendRefinePanel, {
      campaignId: CAMPAIGN,
      enabled: true,
      role: "owner",
      tenantId: TENANT,
    }),
  );
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

/** Scoped to the confirm, whose action shares the panel button's name. */
function dialogButton(label: string): HTMLButtonElement {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error("No confirm dialog is open");
  const match = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Dialog button not found: ${label}`);
  return match;
}

function postBodies(): unknown[] {
  return mocks.post.mock.calls
    .filter(([path]) => path === REFINE_PATH)
    .map(([, body]) => body);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoami.mockResolvedValue(OWNER);
  mocks.whoamiFresh.mockResolvedValue(OWNER);
  mocks.get.mockResolvedValue(SAVED);
  mocks.post.mockResolvedValue(PREVIEW);
  mocks.del.mockResolvedValue({ cleared: 12 });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

describe("pre-send refine panel", () => {
  it("reads the saved set and previews the controls WITHOUT committing", async () => {
    mount();
    await flush();

    expect(mocks.get).toHaveBeenCalledWith(REFINE_PATH, expect.anything());
    expect(postBodies()).toEqual([
      { churn_threshold: 80, exclude_recently_paused: false, dry_run: true },
    ]);

    const panel = document.querySelector<HTMLElement>(
      '[data-testid="presend-refine-panel"]',
    );
    // The saved set and the previewed set are different readings and both are
    // on screen: 12 committed, 40 the current controls would commit.
    expect(panel?.textContent).toContain("12 excluded");
    expect(panel?.dataset.state).toBe("applied");
    expect(
      document.querySelector('[data-testid="presend-refine-preview"]')
        ?.textContent,
    ).toContain("40");
    expect(panel?.textContent).toContain("churny@example.com");
  });

  it("commits with dry_run false when the operator applies the refinement", async () => {
    mount();
    await flush();

    mocks.post.mockResolvedValueOnce({ ...PREVIEW, dry_run: false });
    act(() => button("Apply refinement").click());
    await flush();

    expect(postBodies()).toEqual([
      { churn_threshold: 80, exclude_recently_paused: false, dry_run: true },
      { churn_threshold: 80, exclude_recently_paused: false, dry_run: false },
    ]);
    // Authority is re-read against the live session before the write.
    expect(mocks.whoamiFresh).toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Refinement applied — 40 subscribers excluded from this send.",
    );
  });

  it("carries the moved controls into the preview AND the commit", async () => {
    mount();
    await flush();

    const slider = document.getElementById(
      "presend-refine-threshold",
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(slider, "55");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const toggle = [
      ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ][0];
    act(() => toggle.click());
    // The debounce has to elapse before the preview describes these controls.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await flush();

    expect(postBodies().at(-1)).toEqual({
      churn_threshold: 55,
      exclude_recently_paused: true,
      dry_run: true,
    });

    act(() => button("Apply refinement").click());
    await flush();
    expect(postBodies().at(-1)).toEqual({
      churn_threshold: 55,
      exclude_recently_paused: true,
      dry_run: false,
    });
  });

  it("refuses to commit a set the preview has not caught up with", async () => {
    mount();
    await flush();

    const slider = document.getElementById(
      "presend-refine-threshold",
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(slider, "44");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(button("Apply refinement").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Wait for the preview so the committed set matches these controls",
    );
  });

  it("clears the saved exclusions only after a confirm that names the consequence", async () => {
    mount();
    await flush();

    act(() => button("Clear exclusions").click());
    await flush();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Clear audience refinement?");
    expect(dialog?.textContent).toContain(
      "All 12 saved exclusions re-enter this send immediately",
    );
    expect(dialog?.textContent).toContain("No subscriber is deleted");
    // Nothing has been sent yet — opening the confirm is not the verb.
    expect(mocks.del).not.toHaveBeenCalled();

    act(() => dialogButton("Clear exclusions").click());
    await flush();

    expect(mocks.del).toHaveBeenCalledWith(
      REFINE_PATH,
      expect.objectContaining({ requireOnline: true }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "12 exclusions cleared — everyone re-enters this send.",
    );
  });

  // The panel sits inside the Send dialog, beside the real "Send now". The
  // clear verb was labelled "Send anyway" (its confirm: "Clear exclusions and
  // send anyway") while it only DELETEs the saved exclusions. Nothing in the
  // panel may read as a send, and using it must write nothing but the DELETE.
  it("never labels the clear verb as a send, and clearing sends nothing", async () => {
    mount();
    await flush();

    const panel = document.querySelector<HTMLElement>(
      '[data-testid="presend-refine-panel"]',
    );
    const panelButtons = [...(panel?.querySelectorAll("button") ?? [])];
    expect(panelButtons.length).toBeGreaterThan(0);
    for (const control of panelButtons) {
      const name = control.getAttribute("aria-label") ?? control.textContent ?? "";
      expect(name).not.toMatch(/\bsend\b/i);
    }
    expect(panel?.textContent).toContain(
      "Clear exclusions puts everyone back into this send.",
    );

    act(() => button("Clear exclusions").click());
    await flush();
    const confirm = document.querySelector('[role="dialog"]');
    for (const control of confirm?.querySelectorAll("button") ?? []) {
      expect(control.textContent ?? "").not.toMatch(/\bsend\b/i);
    }
    act(() => dialogButton("Clear exclusions").click());
    await flush();

    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(
      mocks.post.mock.calls.filter(([path]) => String(path).includes("/queue")),
    ).toHaveLength(0);
  });

  it("withholds both write verbs from a viewer with the reason", async () => {
    mocks.whoami.mockResolvedValue(VIEWER);
    mount();
    await flush();

    expect(button("Apply refinement").disabled).toBe(true);
    expect(button("Clear exclusions").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Campaign changes are read-only for this session.",
    );
  });

  it("says the feature is absent rather than showing controls that cannot work", async () => {
    const { ApiError } = (await import("@/lib/api")) as unknown as {
      ApiError: new (message: string) => Error & { status: number };
    };
    const notFound = new ApiError("not found");
    notFound.status = 404;
    mocks.get.mockRejectedValue(notFound);
    mount();
    await flush();

    const panel = document.querySelector<HTMLElement>(
      '[data-testid="presend-refine-panel"]',
    );
    expect(panel?.dataset.state).toBe("unavailable");
    expect(panel?.textContent).toContain(
      "not available in this deployment",
    );
  });
});
