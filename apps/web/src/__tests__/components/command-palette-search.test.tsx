// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Phase 4 — search parity: the web command palette is entity-aware. Typing a
// query must surface server search hits (through cmdk's filter) and selecting
// one must navigate to that entity's destination. This is the end-to-end proof
// the results actually render — the piece pure-function tests can't cover.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  global: vi.fn(),
  catalog: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));
// Keep the real pure mappers; stub only the network call.
vi.mock("@/lib/search-api", async (orig) => {
  const actual = await orig<typeof import("@/lib/search-api")>();
  return { ...actual, searchApi: { global: mocks.global } };
});
vi.mock("@/lib/integrations-catalog-api", () => ({
  integrationsCatalogApi: { get: mocks.catalog },
}));

import { CommandPalette } from "@/components/command-palette";

const roots: Root[] = [];

beforeEach(() => {
  mocks.global.mockReset();
  mocks.catalog.mockReset();
  mocks.catalog.mockResolvedValue({ items: [] });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.clearAllMocks();
  document.body.replaceChildren();
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  roots.push(root);
  return root;
}

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CommandPalette entity search", () => {
  it("omits the retention command and stale recent entry for denied roles", async () => {
    window.localStorage.setItem(
      "pw:recent-destinations:tenant-denied",
      JSON.stringify([
        { href: "/app/retention", label: "Win-back" },
        { href: "/app/commerce", label: "Commerce" },
      ]),
    );
    render(
      <CommandPalette
        tenantId="tenant-denied"
        canAccessRetention={false}
        canAccessAdmin={false}
        canWrite={false}
      />,
    );
    await act(async () => {
      window.dispatchEvent(new Event("pw:open-command-palette"));
      await wait(0);
    });

    expect(document.body.textContent).not.toContain("Win-back");
    expect(document.body.textContent).not.toContain("Commerce");
    expect(document.body.textContent).not.toContain("New campaign");
    expect(document.body.textContent).not.toContain("Export audit log");
    expect(
      Array.from(document.querySelectorAll("[cmdk-item]")).some(
        (item) => item.textContent?.includes("Win-back") === true,
      ),
    ).toBe(false);
  });

  it("renders server hits and navigates to the hit destination on select", async () => {
    mocks.global.mockResolvedValue({
      query: "john",
      results: [{ type: "subscriber", id: "sub_1", title: "John Doe" }],
    });

    render(createElement(CommandPalette));

    // Open the palette.
    await act(async () => {
      window.dispatchEvent(new Event("pw:open-command-palette"));
      await wait(0);
    });

    const input = document.querySelector(
      'input[placeholder="Search subscribers, segments, pages…"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    // Type a query and let the 200ms debounce + fetch resolve.
    await act(async () => {
      typeInto(input, "john");
      await wait(300);
    });

    // The search was issued with the typed query.
    expect(mocks.global).toHaveBeenCalledWith(
      "john",
      expect.objectContaining({ limit: 8 }),
    );

    // The hit is rendered (cmdk kept it through the filter).
    const hit = Array.from(document.querySelectorAll("[cmdk-item]")).find(
      (el) => el.textContent?.includes("John Doe"),
    ) as HTMLElement | undefined;
    expect(hit, "expected the server hit row to render").toBeTruthy();

    // Selecting it navigates to the subscriber's detail route.
    await act(async () => {
      hit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await wait(0);
    });
    await act(async () => {
      await new Promise((r) => window.requestAnimationFrame(r));
      await wait(0);
    });
    expect(mocks.push).toHaveBeenCalledWith("/app/subscribers/sub_1");
  });

  it("does not query the server for a single character", async () => {
    render(createElement(CommandPalette));
    await act(async () => {
      window.dispatchEvent(new Event("pw:open-command-palette"));
      await wait(0);
    });
    const input = document.querySelector(
      'input[placeholder="Search subscribers, segments, pages…"]',
    ) as HTMLInputElement;
    await act(async () => {
      typeInto(input, "j");
      await wait(300);
    });
    expect(mocks.global).not.toHaveBeenCalled();
  });

  it("reports a failed server search instead of presenting it as no matches", async () => {
    mocks.global.mockRejectedValue(new Error("search unavailable"));
    render(createElement(CommandPalette));
    await act(async () => {
      window.dispatchEvent(new Event("pw:open-command-palette"));
      await wait(0);
    });
    const input = document.querySelector(
      'input[placeholder="Search subscribers, segments, pages…"]',
    ) as HTMLInputElement;

    await act(async () => {
      typeInto(input, "zz-no-route");
      await wait(300);
    });

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Search is temporarily unavailable",
    );
    expect(document.body.textContent).not.toContain("No matches.");
    const list = document.querySelector("[cmdk-list]")!;
    expect(
      Array.from(list.children).some(
        (child) => child.getAttribute("role") === "presentation",
      ),
    ).toBe(false);
  });

  it("announces no matches outside the suggestions listbox", async () => {
    mocks.global.mockResolvedValue({ query: "zz-no-route", results: [] });
    render(createElement(CommandPalette));
    await act(async () => {
      window.dispatchEvent(new Event("pw:open-command-palette"));
      await wait(0);
    });
    const input = document.querySelector(
      'input[placeholder="Search subscribers, segments, pages…"]',
    ) as HTMLInputElement;

    await act(async () => {
      typeInto(input, "zz-no-route");
      await wait(300);
    });

    const status = Array.from(
      document.querySelectorAll<HTMLElement>('[role="status"]'),
    ).find((node) => node.textContent?.includes("No matches"));
    const list = document.querySelector("[cmdk-list]")!;
    expect(status).toBeTruthy();
    expect(list.contains(status!)).toBe(false);
  });

  it("ignores a superseded response even when its transport resolves after abort", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    mocks.global
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveFirst = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveSecond = resolve)),
      );
    render(createElement(CommandPalette));
    await act(async () => {
      window.dispatchEvent(new Event("pw:open-command-palette"));
      await wait(0);
    });
    const input = document.querySelector(
      'input[placeholder="Search subscribers, segments, pages…"]',
    ) as HTMLInputElement;

    await act(async () => {
      typeInto(input, "alpha");
      await wait(240);
    });
    await act(async () => {
      typeInto(input, "omega");
      await wait(240);
    });
    expect(mocks.global).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveFirst({
        query: "alpha",
        results: [{ type: "subscriber", id: "old", title: "Old result" }],
      });
      await wait(0);
    });
    expect(document.body.textContent).not.toContain("Old result");
    expect(document.body.textContent).toContain("Searching…");

    await act(async () => {
      resolveSecond({
        query: "omega",
        results: [{ type: "subscriber", id: "new", title: "New result" }],
      });
      await wait(0);
    });
    expect(document.body.textContent).toContain("New result");
    expect(document.body.textContent).not.toContain("Old result");
  });
});
