// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-39 — Saved views: save the current view under a name, apply one,
// delete one. Asserted by consequence: what lands in the identity-scoped
// localStorage key, what the URL becomes on Apply (and that the page's
// popstate readers are told), what the delete confirm says, and that another
// account's views never appear.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

import { SavedViewsMenu } from "@/components/analytics/saved-views-menu";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "user-1";
const KEY = `postwave.web.analytics-saved-views.v1:${TENANT}:${USER}`;

let me: { user_id: string; tenant_id: string } = {
  user_id: USER,
  tenant_id: TENANT,
};

function stubFetch() {
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(raw, "http://localhost");
    if (url.pathname === "/api/v1/auth/me") {
      return new Response(
        JSON.stringify({
          ...me,
          email: "a@example.com",
          role: "viewer",
          auth_provider: "password",
          email_verified: true,
          workspace_name: "W",
          workspace_slug: "w",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

let root: Root | null = null;

async function flush() {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => flush());
    }
  }
  throw lastError;
}

async function render(search: string) {
  window.history.replaceState(null, "", `/app/analytics${search}`);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SavedViewsMenu),
      ),
    );
  });
  await waitFor(() => expect(trigger().disabled).toBe(false));
  return container;
}

function trigger(): HTMLButtonElement {
  const el = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Views",
  );
  if (!el) throw new Error("no Views trigger");
  return el as HTMLButtonElement;
}

function buttonByName(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("aria-label") === name || b.textContent?.trim() === name,
  );
  if (!match) throw new Error(`no button ${name}`);
  return match as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await act(async () => flush());
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function nameInput(): HTMLInputElement {
  const label = [...document.querySelectorAll("label")].find(
    (l) => l.textContent === "View name",
  );
  const input = label
    ? document.getElementById(label.getAttribute("for") ?? "")
    : null;
  if (!(input instanceof HTMLInputElement)) throw new Error("no name input");
  return input;
}

async function saveCurrentAs(name: string) {
  await click(trigger());
  await click(buttonByName("Save current view…"));
  await type(nameInput(), name);
  await click(buttonByName("Save view"));
}

function stored(): unknown[] {
  return JSON.parse(window.localStorage.getItem(KEY) ?? "[]") as unknown[];
}

beforeEach(() => {
  me = { user_id: USER, tenant_id: TENANT };
  window.localStorage.clear();
  stubFetch();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("Saved views (analytics-39)", () => {
  it("saves the current URL view — range, tab, metric, focus, compare, group-by — under the workspace+user key", async () => {
    await render(
      "?range=7d&tab=campaign&metric=opens&focus=grouped-breakdown&compare=off&group_by=domain",
    );
    await saveCurrentAs("  Weekly domains ");

    const views = stored();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      name: "Weekly domains",
      range: "7d",
      tab: "campaign",
      metric: "opens",
      focus: "grouped-breakdown",
      compare: false,
      groupBy: "domain",
    });
    expect(toastMocks.success).toHaveBeenCalledWith(
      "Saved view “Weekly domains”.",
    );
    // Nothing else was written, and nothing was sent to the server.
    expect(Object.keys(window.localStorage)).toEqual([KEY]);

    // It is listed, marked as the view on screen now.
    await click(trigger());
    expect(
      buttonByName("Apply saved view Weekly domains (current)"),
    ).toBeTruthy();
  });

  it("apply writes the saved state back to the URL and tells the page's popstate readers", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          id: "v-1",
          name: "Quarter clicks",
          range: "90d",
          tab: "overview",
          metric: "clicks",
          focus: null,
          compare: false,
          groupBy: "campaign",
        },
      ]),
    );
    await render("?range=7d&metric=opens&utm=keep");
    const popstates: Array<unknown> = [];
    const onPop = (event: PopStateEvent) => popstates.push(event.state);
    window.addEventListener("popstate", onPop);
    const before = window.history.length;

    await click(trigger());
    await click(buttonByName("Apply saved view Quarter clicks"));
    window.removeEventListener("popstate", onPop);

    expect(window.location.pathname).toBe("/app/analytics");
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({
      range: "90d",
      metric: "clicks",
      utm: "keep",
      compare: "off",
      group_by: "campaign",
    });
    // One history entry, so Back returns to the previous view.
    expect(window.history.length).toBe(before + 1);
    // A state-less popstate: the page resyncs, the app router ignores it.
    expect(popstates).toEqual([null]);
    // The panel closed and the choice was announced.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain(
      "Applied saved view Quarter clicks.",
    );
  });

  it("delete confirms, names the consequence, and removes only that view", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: "v-1", name: "Keep me", range: "7d", tab: "overview", metric: null, focus: null, compare: true, groupBy: null },
        { id: "v-2", name: "Drop me", range: "30d", tab: "overview", metric: null, focus: null, compare: true, groupBy: null },
      ]),
    );
    await render("");
    await click(trigger());
    await click(buttonByName("Delete saved view Drop me"));

    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    expect(dialog?.textContent).toContain("Delete saved view?");
    expect(dialog?.textContent).toContain(
      "“Drop me” will be removed from your saved views in this browser. Your analytics data isn't affected, and this can't be undone.",
    );
    // Nothing is removed until the confirm.
    expect(stored()).toHaveLength(2);

    await click(buttonByName("Delete view"));
    await waitFor(() =>
      expect((stored() as Array<{ id: string }>).map((v) => v.id)).toEqual([
        "v-1",
      ]),
    );
  });

  it("rejects a duplicate name and keeps the list unchanged", async () => {
    await render("?range=7d");
    await saveCurrentAs("Mine");
    await saveCurrentAs("MINE");
    expect(document.body.textContent).toContain(
      "You already have a view with that name.",
    );
    expect(stored()).toHaveLength(1);
  });

  it("a storage failure is said in the dialog, not swallowed", async () => {
    await render("?range=7d");
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
    await saveCurrentAs("Will fail");
    setItem.mockRestore();
    expect(document.body.textContent).toContain(
      "This browser's storage for Moosewave is full, so the view couldn't be saved.",
    );
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(0);
  });

  it("never shows another account's views", async () => {
    window.localStorage.setItem(
      `postwave.web.analytics-saved-views.v1:${TENANT}:someone-else`,
      JSON.stringify([
        { id: "v-9", name: "Not yours", range: "7d", tab: "overview", metric: null, focus: null, compare: true, groupBy: null },
      ]),
    );
    await render("");
    await click(trigger());
    expect(document.body.textContent).not.toContain("Not yours");
    expect(document.body.textContent).toContain("No saved views yet.");
  });
});
