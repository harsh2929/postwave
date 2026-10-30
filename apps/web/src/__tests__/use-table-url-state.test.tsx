// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enumParam, intParam, stringParam } from "@/lib/table-url-state";
import { useTableUrlState } from "@/lib/use-table-url-state";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  search: "",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/records",
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

const schema = {
  page: intParam(1),
  from: stringParam(""),
  to: stringParam(""),
  status: enumParam(["all", "active"] as const, "all"),
} as const;

let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  navigation.replace.mockClear();
  navigation.search = "";
  document.body.innerHTML = "";
});

function Harness() {
  const { state, setState, reset } = useTableUrlState(schema);

  return createElement(
    "div",
    null,
    createElement("output", { "data-testid": "state" }, JSON.stringify(state)),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => setState({ from: "2026-05-01", page: 1 }),
      },
      "Set from",
    ),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => setState({ to: "2026-04-01", page: 1 }),
      },
      "Set to",
    ),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => setState({ status: "active", page: 1 }),
      },
      "Set active",
    ),
    createElement(
      "button",
      {
        type: "button",
        onClick: reset,
      },
      "Reset",
    ),
  );
}

function renderHarness(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(Harness)));
  return container;
}

function click(container: HTMLElement, label: string): void {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`Missing ${label} button`);
  act(() => button.click());
}

function publish(search: string): void {
  navigation.search = search;
  act(() => root?.render(createElement(Harness)));
}

function renderedState(container: HTMLElement): string {
  return container.querySelector("[data-testid='state']")?.textContent ?? "";
}

describe("useTableUrlState", () => {
  it("keeps the latest optimistic state across intermediate URL publications", () => {
    const container = renderHarness();

    click(container, "Set from");
    click(container, "Set to");

    expect(navigation.replace).toHaveBeenCalledTimes(1);
    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/app/records?from=2026-05-01",
      { scroll: false },
    );
    expect(renderedState(container)).toContain('"to":"2026-04-01"');

    publish("from=2026-05-01");

    expect(renderedState(container)).toContain('"to":"2026-04-01"');
    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/app/records?from=2026-05-01&to=2026-04-01",
      { scroll: false },
    );

    click(container, "Set active");
    expect(renderedState(container)).toContain('"status":"active"');

    publish("from=2026-05-01&to=2026-04-01");

    expect(renderedState(container)).toContain('"status":"active"');
    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/app/records?from=2026-05-01&to=2026-04-01&status=active",
      { scroll: false },
    );

    publish("from=2026-05-01&to=2026-04-01&status=active");
    expect(renderedState(container)).toBe(
      '{"page":1,"from":"2026-05-01","to":"2026-04-01","status":"active"}',
    );
  });

  it("accepts unknown external URL state and composes from it", () => {
    const container = renderHarness();

    click(container, "Set from");
    publish("status=active");

    expect(renderedState(container)).toBe(
      '{"page":1,"from":"","to":"","status":"active"}',
    );

    click(container, "Set to");
    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/app/records?to=2026-04-01&status=active",
      { scroll: false },
    );
  });

  it("resets optimistic state before a queued follow-up patch", () => {
    const container = renderHarness();

    click(container, "Set from");
    click(container, "Reset");
    click(container, "Set active");

    expect(renderedState(container)).toBe(
      '{"page":1,"from":"","to":"","status":"active"}',
    );

    publish("from=2026-05-01");

    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/app/records?status=active",
      { scroll: false },
    );
  });
});
