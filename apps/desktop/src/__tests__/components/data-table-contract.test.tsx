// @vitest-environment happy-dom

import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  DataTable,
  DataTableLoadMore,
  DataTablePagination,
  type DataTableColumn,
  type DataTableSortState,
} from "../../components/table/DataTable";

interface Row {
  id: string;
  name: string;
  count: number;
  locked?: boolean;
}

const ROWS: readonly Row[] = [
  { id: "alpha", name: "Alpha", count: 12 },
  { id: "beta", name: "Beta", count: 4, locked: true },
];

const COLUMNS: readonly DataTableColumn<Row>[] = [
  {
    id: "name",
    header: "Name",
    sortable: true,
    cell: (row) => row.name,
  },
  {
    id: "count",
    header: "Count",
    align: "end",
    cell: (row) => row.count,
  },
  {
    id: "actions",
    header: <span className="visually-hidden">Actions</span>,
    cell: (row) => <button type="button">Open {row.name}</button>,
  },
];

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

function InteractiveTable({
  onSort,
}: {
  onSort: (sort: DataTableSortState) => void;
}): ReactElement {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sort, setSort] = useState<DataTableSortState>({
    columnId: "name",
    direction: "asc",
  });
  return (
    <DataTable
      caption="Delivery attempts"
      description="Current workspace · last seven days"
      columns={COLUMNS}
      rows={ROWS}
      getRowKey={(row) => row.id}
      sort={sort}
      onSortChange={(next) => {
        setSort(next);
        onSort(next);
      }}
      selection={{
        selectedKeys: selected,
        onSelectionChange: setSelected,
        label: (row) => row.name,
        isDisabled: (row) => Boolean(row.locked),
        scopeLabel: "delivery attempts on this page",
      }}
      bulkActions={<button type="button">Retry selected</button>}
    />
  );
}

function ExpandableTable(): ReactElement {
  const [expanded, setExpanded] = useState<string | null>(null);
  const columns: readonly DataTableColumn<Row>[] = [
    {
      id: "name",
      header: "Name",
      cell: (row) => (
        <button
          type="button"
          aria-expanded={expanded === row.id}
          aria-controls={`details-${row.id}`}
          onClick={() =>
            setExpanded((current) => (current === row.id ? null : row.id))
          }
        >
          {row.name}
        </button>
      ),
    },
  ];
  return (
    <DataTable
      caption="Expandable jobs"
      columns={columns}
      rows={ROWS}
      getRowKey={(row) => row.id}
      expansion={{
        isExpanded: (row) => expanded === row.id,
        label: (row) => `${row.name} details`,
        regionId: (row) => `details-${row.id}`,
        render: (row) => <p>{row.count} processed records</p>,
      }}
    />
  );
}

describe("qualified data table contract", () => {
  it("associates caption, description, native headers, rows, and explicit actions", () => {
    render(<InteractiveTable onSort={() => undefined} />);

    const table = document.querySelector("table")!;
    expect(table.querySelector("caption")?.textContent).toBe(
      "Delivery attempts",
    );
    expect(table.querySelectorAll('th[scope="col"]')).toHaveLength(4);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(document.querySelector("button")?.textContent).toContain("Name");
    expect(document.body.textContent).toContain("Open Alpha");

    const scrollRegion = document.querySelector<HTMLDivElement>(
      ".pw-data-table__scroll",
    )!;
    expect(scrollRegion.tabIndex).toBe(0);
    expect(scrollRegion.getAttribute("aria-labelledby")).toBeTruthy();
    expect(scrollRegion.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("publishes controlled aria-sort state and announces the next ordering", () => {
    const onSort = vi.fn();
    render(<InteractiveTable onSort={onSort} />);
    const nameHeader = Array.from(document.querySelectorAll("th")).find(
      (header) => header.textContent?.includes("Name"),
    )!;
    expect(nameHeader.getAttribute("aria-sort")).toBe("ascending");
    const button = nameHeader.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toContain("currently ascending");

    act(() => button.click());
    expect(onSort).toHaveBeenCalledWith({
      columnId: "name",
      direction: "desc",
    });
    expect(nameHeader.getAttribute("aria-sort")).toBe("descending");
  });

  it("selects named rows, exposes bulk actions, and excludes disabled rows from select-all", () => {
    render(<InteractiveTable onSort={() => undefined} />);
    const rowCheckboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        'tbody input[type="checkbox"]',
      ),
    );
    expect(rowCheckboxes[0]?.getAttribute("aria-label")).toBe("Select Alpha");
    expect(rowCheckboxes[1]?.disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Retry selected");

    act(() => rowCheckboxes[0]?.click());
    expect(rowCheckboxes[0]?.getAttribute("aria-label")).toBe("Deselect Alpha");
    expect(document.body.textContent).toContain("1 selected");
    expect(document.body.textContent).toContain("Retry selected");

    const selectAll = document.querySelector<HTMLInputElement>(
      'thead input[type="checkbox"]',
    )!;
    expect(selectAll.checked).toBe(true);
    expect(selectAll.getAttribute("aria-label")).toBe(
      "Deselect all delivery attempts on this page",
    );
  });

  it("keeps headers and a status row present while loading or empty", () => {
    render(
      <DataTable
        caption="Queued jobs"
        columns={COLUMNS}
        rows={[]}
        getRowKey={(row) => row.id}
        loading
        loadingLabel="Loading queued jobs…"
      />,
    );
    expect(document.querySelector("tbody")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(document.querySelector("tbody td")?.getAttribute("colspan")).toBe(
      "3",
    );
    expect(document.body.textContent).toContain("Loading queued jobs…");

    act(() =>
      root?.render(
        <DataTable
          caption="Queued jobs"
          columns={COLUMNS}
          rows={[]}
          getRowKey={(row) => row.id}
          emptyState="No queued jobs."
        />,
      ),
    );
    expect(document.body.textContent).toContain("No queued jobs.");
    expect(document.querySelectorAll('th[scope="col"]')).toHaveLength(3);
  });

  it("associates explicit disclosure controls with full-width detail regions", () => {
    render(<ExpandableTable />);
    const alpha = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Alpha",
    )!;
    expect(alpha.getAttribute("aria-expanded")).toBe("false");
    act(() => alpha.click());
    expect(alpha.getAttribute("aria-expanded")).toBe("true");
    const details = document.querySelector('#details-alpha[role="region"]')!;
    expect(details.getAttribute("aria-label")).toBe("Alpha details");
    expect(details.textContent).toContain("12 processed records");
    expect(details.closest("td")?.getAttribute("colspan")).toBe("1");
  });

  it("labels pagination, announces page state, and keeps unavailable directions disabled", () => {
    const onNext = vi.fn();
    const onPageSizeChange = vi.fn();
    render(
      <DataTablePagination
        label="Campaigns"
        page={2}
        pageCount={4}
        hasPrevious
        hasNext
        onPrevious={() => undefined}
        onNext={onNext}
        itemSummary="26–50 of 84 campaigns"
        pageSize={25}
        pageSizeOptions={[25, 50, 100]}
        onPageSizeChange={onPageSizeChange}
      />,
    );
    expect(document.querySelector("nav")?.getAttribute("aria-label")).toBe(
      "Campaigns pagination",
    );
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Page 2 of 4",
    );
    expect(document.body.textContent).toContain("26–50 of 84 campaigns");

    const next = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Next page of Campaigns"]',
    )!;
    act(() => next.click());
    expect(onNext).toHaveBeenCalledOnce();
    const pageSize = document.querySelector<HTMLSelectElement>("select")!;
    act(() => {
      pageSize.value = "50";
      pageSize.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });

  it("announces additive cursor progress without pretending it is page navigation", () => {
    const onLoadMore = vi.fn();
    render(
      <DataTableLoadMore
        label="Audit log"
        loadedCount={50}
        totalCount={121}
        totalIsApproximate
        hasMore
        onLoadMore={onLoadMore}
      />,
    );
    expect(document.querySelector("nav")?.getAttribute("aria-label")).toBe(
      "Audit log result controls",
    );
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Showing 50 of ~121",
    );
    const loadMore = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Load more",
    )!;
    act(() => loadMore.click());
    expect(onLoadMore).toHaveBeenCalledOnce();
  });
});
