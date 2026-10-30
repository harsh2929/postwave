// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditListView } from "../../pages/audit/AuditListView";
import type { AuditPageController } from "../../pages/audit/useAuditPageController";

vi.mock("../../components/audit/AuditRowItem", () => ({
  AuditRowItem: ({ row }: { row: { id: string } }) => (
    <button type="button" data-testid="audit-window-row">
      Audit {row.id}
    </button>
  ),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function controllerWithRows(count: number): AuditPageController {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    action: "campaign.updated",
  }));
  return {
    setSelected: () => undefined,
    data: {
      rows,
      visibleRows: rows,
      loading: false,
      totalCount: count,
      totalConfidence: "exact",
      nextCursor: null,
      loadingMore: false,
      onLoadMore: async () => undefined,
    },
    filters: {
      actionQuery: "",
      resourceId: "",
      actorLabel: "",
      actorType: "any",
      resourceType: "",
      category: "all",
      setActorFromRow: () => undefined,
      setResourceId: () => undefined,
    },
  } as unknown as AuditPageController;
}

describe("audit large-result integrity", () => {
  it("renders the full decoded page in a bounded semantic table", () => {
    render(<AuditListView controller={controllerWithRows(201)} />);
    const table = document.querySelector('[role="table"]')!;
    expect(table.getAttribute("aria-label")).toBe("Audit events");
    expect(table.getAttribute("aria-rowcount")).toBe("202");
    expect(document.querySelectorAll('[role="columnheader"]')).toHaveLength(5);
    expect(
      document.querySelectorAll('[data-testid="audit-window-row"]'),
    ).toHaveLength(201);
    expect(document.querySelector('[role="list"]')).toBeNull();
  });

  it("does not expose loading or empty placeholders as malformed table rows", () => {
    const controller = controllerWithRows(0);
    controller.data.rows = null;
    controller.data.visibleRows = null;
    controller.data.loading = true;
    render(<AuditListView controller={controller} />);

    expect(document.querySelector('[role="table"]')).toBeNull();
    expect(document.querySelector('[role="region"]')?.getAttribute("aria-busy"))
      .toBe("true");
    expect(document.querySelector('[role="columnheader"]')).toBeNull();
  });
});
