// @vitest-environment happy-dom

import {
  act,
  type Dispatch,
  type ReactElement,
  type SetStateAction,
  useMemo,
  useState,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Subscriber } from "../../lib/api-client";
import type { SubscribersData } from "../../pages/subscribers/useSubscribersData";
import {
  useSubscribersPageState,
  type SubscribersPageState,
} from "../../pages/subscribers/useSubscribersPageState";
import {
  useSubscribersSelection,
  type SubscribersSelection,
} from "../../pages/subscribers/useSubscribersSelection";

const FIRST_PAGE: Subscriber[] = [
  { id: "subscriber-1", email: "one@example.test" },
  { id: "subscriber-2", email: "two@example.test" },
  { id: "subscriber-3", email: "three@example.test" },
  { id: "subscriber-4", email: "four@example.test" },
];

interface SelectionHarness {
  state: SubscribersPageState;
  selection: SubscribersSelection;
  pageRows: Subscriber[];
  setPageRows: Dispatch<SetStateAction<Subscriber[]>>;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let harness: SelectionHarness | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function Probe(): ReactElement {
  const state = useSubscribersPageState();
  const [pageRows, setPageRows] = useState(FIRST_PAGE);
  const data = useMemo(
    () =>
      ({
        rows: pageRows,
        pageRows,
      }) as SubscribersData,
    [pageRows],
  );
  const selection = useSubscribersSelection(state, data);
  harness = { state, selection, pageRows, setPageRows };
  return (
    <output>
      {selection.selectedRows.map((row) => row.id).join(",") || "none"}
    </output>
  );
}

function renderHarness(): SelectionHarness {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Probe />));
  return currentHarness();
}

function currentHarness(): SelectionHarness {
  if (!harness) throw new Error("Subscribers selection hook did not render");
  return harness;
}

function selectedKeys(): string[] {
  return Array.from(currentHarness().state.selectedKeys);
}

function selectFirstAndFocus(): void {
  act(() => {
    const current = currentHarness();
    current.selection.selectRow(current.pageRows[0], {});
    current.state.setFocusedRowIndex(0);
  });
  expect(selectedKeys()).toEqual(["subscriber-1"]);
}

function expectScopeReset(): void {
  const current = currentHarness();
  expect(selectedKeys()).toEqual([]);
  expect(current.selection.selectedRows).toEqual([]);
  expect(current.state.focusId).toBeNull();
  expect(current.state.focusedRowIndex).toBe(-1);
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  harness = null;
  document.body.replaceChildren();
});

describe("Subscribers page-scoped selection", () => {
  it("preserves click, modifier, range, keyboard-toggle, and page-toggle semantics within one page", () => {
    renderHarness();

    act(() => {
      currentHarness().selection.selectRow(FIRST_PAGE[1], {});
    });
    expect(selectedKeys()).toEqual(["subscriber-2"]);

    act(() => {
      currentHarness().selection.selectRow(FIRST_PAGE[3], { meta: true });
    });
    expect(selectedKeys()).toEqual(["subscriber-2", "subscriber-4"]);

    act(() => {
      currentHarness().selection.selectRow(FIRST_PAGE[2], { shift: true });
    });
    expect(
      currentHarness().selection.selectedRows.map((row) => row.id),
    ).toEqual(["subscriber-2", "subscriber-3", "subscriber-4"]);

    act(() => {
      currentHarness().selection.toggleRow(FIRST_PAGE[0]);
    });
    expect(currentHarness().selection.allPageSelected).toBe(true);

    act(() => {
      currentHarness().selection.togglePage();
    });
    expectScopeReset();

    act(() => {
      currentHarness().selection.togglePage();
    });
    expect(selectedKeys()).toEqual([
      "subscriber-1",
      "subscriber-2",
      "subscriber-3",
      "subscriber-4",
    ]);
    expect(currentHarness().selection.allPageSelected).toBe(true);
  });

  it("clears selection and keyboard anchors on every applied view-scope change", () => {
    renderHarness();

    selectFirstAndFocus();
    act(() => currentHarness().state.setPage(2));
    expectScopeReset();

    selectFirstAndFocus();
    act(() => currentHarness().state.setSortOrder("asc"));
    expectScopeReset();

    selectFirstAndFocus();
    act(() => currentHarness().state.setSortColumn("email"));
    expectScopeReset();

    selectFirstAndFocus();
    act(() => currentHarness().state.setFilter("unsubscribed"));
    expectScopeReset();

    selectFirstAndFocus();
    act(() => currentHarness().state.setShowArchived(true));
    expectScopeReset();

    selectFirstAndFocus();
    act(() => currentHarness().state.setQuery("new audience"));
    expectScopeReset();

    selectFirstAndFocus();
    act(() => currentHarness().state.setDebouncedQuery("new audience"));
    expectScopeReset();
  });

  it("prunes changed rows without carrying hidden ids into bulk actions", () => {
    renderHarness();

    act(() => {
      currentHarness().selection.selectRow(FIRST_PAGE[0], {});
    });
    act(() => {
      currentHarness().selection.selectRow(FIRST_PAGE[2], { meta: true });
      currentHarness().state.setFocusedRowIndex(2);
    });
    expect(selectedKeys()).toEqual(["subscriber-1", "subscriber-3"]);

    act(() => {
      currentHarness().setPageRows([
        FIRST_PAGE[1],
        FIRST_PAGE[2],
        FIRST_PAGE[3],
      ]);
    });

    expect(selectedKeys()).toEqual(["subscriber-3"]);
    expect(
      currentHarness().selection.selectedRows.map((row) => row.id),
    ).toEqual(["subscriber-3"]);
    expect(currentHarness().state.focusId).toBe("subscriber-3");
    expect(currentHarness().state.focusedRowIndex).toBe(1);

    act(() => {
      currentHarness().setPageRows([FIRST_PAGE[1], FIRST_PAGE[3]]);
    });
    expectScopeReset();
  });

  it("rejects stale or foreign rows and clears page selection with Escape", () => {
    renderHarness();
    const foreign: Subscriber = {
      id: "subscriber-foreign",
      email: "foreign@example.test",
    };

    act(() => {
      currentHarness().selection.selectRow(foreign, {});
      currentHarness().selection.toggleRow(foreign);
    });
    expectScopeReset();

    selectFirstAndFocus();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(selectedKeys()).toEqual([]);
    expect(currentHarness().state.focusId).toBeNull();
  });
});
