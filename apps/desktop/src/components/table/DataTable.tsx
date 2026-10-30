import {
  type ChangeEvent,
  Fragment,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";

export type DataTableSortDirection = "asc" | "desc";

export interface DataTableSortState {
  columnId: string;
  direction: DataTableSortDirection;
}

export interface DataTableColumn<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row, rowIndex: number) => ReactNode;
  /** Spoken label used by the sort control when the header is rich JSX. */
  sortLabel?: string;
  sortable?: boolean;
  align?: "start" | "center" | "end";
  width?: string;
  className?: string;
}

export interface DataTableSelection<Row> {
  selectedKeys: ReadonlySet<string>;
  onSelectionChange: (keys: ReadonlySet<string>) => void;
  label: (row: Row) => string;
  isDisabled?: (row: Row) => boolean;
  /** Visible label for the current page/scope, e.g. "campaigns on this page". */
  scopeLabel?: string;
}

export interface DataTableExpansion<Row> {
  isExpanded: (row: Row) => boolean;
  render: (row: Row) => ReactNode;
  label: (row: Row) => string;
  regionId?: (row: Row) => string;
}

export interface DataTableProps<Row> {
  caption: string;
  description?: ReactNode;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowKey: (row: Row) => string;
  sort?: DataTableSortState;
  onSortChange?: (sort: DataTableSortState) => void;
  selection?: DataTableSelection<Row>;
  expansion?: DataTableExpansion<Row>;
  bulkActions?: ReactNode;
  columnControls?: ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  emptyState?: ReactNode;
  density?: "comfortable" | "compact";
  stickyHeader?: boolean;
  className?: string;
  rowClassName?: (row: Row) => string | undefined;
}

export interface DataTablePaginationProps {
  label: string;
  page: number;
  pageCount?: number | null;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onFirst?: () => void;
  onLast?: () => void;
  busy?: boolean;
  itemSummary?: ReactNode;
  pageSize?: number;
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (pageSize: number) => void;
}

export interface DataTableLoadMoreProps {
  label: string;
  loadedCount: number;
  totalCount?: number | null;
  totalIsApproximate?: boolean;
  hasMore: boolean;
  busy?: boolean;
  onLoadMore: () => void;
  onJumpToEnd?: () => void;
  endLabel?: ReactNode;
}

/**
 * Qualified native data table for decision-bearing collections.
 *
 * It deliberately avoids clickable rows: navigation and mutations belong in
 * named links/buttons inside cells, which keeps nested controls and keyboard
 * behavior predictable. Sorting is controlled so server and client ordering
 * cannot drift from the announced state.
 */
export function DataTable<Row>({
  caption,
  description,
  columns,
  rows,
  getRowKey,
  sort,
  onSortChange,
  selection,
  expansion,
  bulkActions,
  columnControls,
  loading = false,
  loadingLabel = "Loading rows…",
  emptyState = "No rows available.",
  density = "comfortable",
  stickyHeader = true,
  className,
  rowClassName,
}: DataTableProps<Row>): ReactElement {
  const labelId = useId();
  const descriptionId = useId();
  const rowKeys = useMemo(() => rows.map(getRowKey), [getRowKey, rows]);
  const selectionState = useSelectionState(rows, rowKeys, selection);
  const hasToolbar = Boolean(bulkActions && selectionState);

  return (
    <div
      className={`pw-data-table${className ? ` ${className}` : ""}`}
      data-density={density}
    >
      <div className="pw-data-table__heading">
        <div>
          <div id={labelId} className="pw-data-table__caption">
            {caption}
          </div>
          {description ? (
            <div id={descriptionId} className="pw-data-table__description">
              {description}
            </div>
          ) : null}
        </div>
        {columnControls ? (
          <div className="pw-data-table__column-controls">{columnControls}</div>
        ) : null}
      </div>

      {hasToolbar ? (
        <div
          className="pw-data-table__toolbar"
          role="region"
          aria-label={`${caption} bulk actions`}
        >
          {selectionState ? (
            <span className="pw-data-table__selection-summary" role="status">
              {selectionState.selectedCount.toLocaleString()} selected
            </span>
          ) : null}
          {selectionState && selectionState.selectedCount > 0
            ? bulkActions
            : null}
        </div>
      ) : null}

      <div
        className="pw-data-table__scroll"
        role="region"
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        // Keyboard users must be able to focus and pan an overflowing table;
        // the region itself performs no custom key handling.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
      >
        <table aria-label={caption}>
          <caption className="visually-hidden">{caption}</caption>
          <colgroup>
            {selection ? (
              <col className="pw-data-table__selection-col" />
            ) : null}
            {columns.map((column) => (
              <col
                key={column.id}
                style={column.width ? { width: column.width } : undefined}
              />
            ))}
          </colgroup>
          <thead className={stickyHeader ? "is-sticky" : undefined}>
            <tr>
              {selection && selectionState ? (
                <SelectionHeader
                  caption={caption}
                  selection={selection}
                  state={selectionState}
                />
              ) : null}
              {columns.map((column) => (
                <ColumnHeader
                  key={column.id}
                  column={column}
                  sort={sort}
                  onSortChange={onSortChange}
                />
              ))}
            </tr>
          </thead>
          <tbody aria-busy={loading || undefined}>
            {loading ? (
              <StatusRow
                columnCount={columns.length + (selection ? 1 : 0)}
                content={loadingLabel}
              />
            ) : rows.length === 0 ? (
              <StatusRow
                columnCount={columns.length + (selection ? 1 : 0)}
                content={emptyState}
              />
            ) : (
              rows.map((row, rowIndex) => {
                const key = rowKeys[rowIndex] ?? getRowKey(row);
                const expanded = expansion?.isExpanded(row) ?? false;
                return (
                  <Fragment key={key}>
                    <tr
                      className={rowClassName?.(row)}
                      data-selected={
                        selection?.selectedKeys.has(key) || undefined
                      }
                      data-expanded={expanded || undefined}
                    >
                      {selection ? (
                        <SelectionCell
                          row={row}
                          rowKey={key}
                          selection={selection}
                        />
                      ) : null}
                      {columns.map((column) => (
                        <td
                          key={column.id}
                          className={column.className}
                          data-align={column.align ?? "start"}
                        >
                          {column.cell(row, rowIndex)}
                        </td>
                      ))}
                    </tr>
                    {expanded && expansion ? (
                      <tr className="pw-data-table__expanded-row">
                        <td colSpan={columns.length + (selection ? 1 : 0)}>
                          <div
                            id={expansion.regionId?.(row)}
                            role="region"
                            aria-label={expansion.label(row)}
                          >
                            {expansion.render(row)}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function DataTablePagination({
  label,
  page,
  pageCount,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  onFirst,
  onLast,
  busy = false,
  itemSummary,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
}: DataTablePaginationProps): ReactElement {
  const boundedPage = Math.max(1, Math.floor(page));
  const boundedPageCount =
    pageCount == null ? null : Math.max(1, Math.floor(pageCount));
  const status = boundedPageCount
    ? `Page ${boundedPage.toLocaleString()} of ${boundedPageCount.toLocaleString()}`
    : `Page ${boundedPage.toLocaleString()}`;
  const showPageSize =
    pageSize != null && pageSizeOptions?.length && onPageSizeChange;
  return (
    <nav
      className="pw-data-table-pagination"
      aria-label={`${label} pagination`}
    >
      <div className="pw-data-table-pagination__summary">
        {itemSummary ?? null}
      </div>
      <div className="pw-data-table-pagination__controls">
        {showPageSize ? (
          <label className="pw-data-table-pagination__size">
            <span>Rows per page</span>
            <select
              value={pageSize}
              disabled={busy}
              onChange={(event) =>
                onPageSizeChange(Number(event.currentTarget.value))
              }
            >
              {pageSizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {onFirst ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy || !hasPrevious}
            onClick={onFirst}
            aria-label={`First page of ${label}`}
          >
            First
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || !hasPrevious}
          onClick={onPrevious}
          aria-label={`Previous page of ${label}`}
        >
          Previous
        </button>
        <span
          className="pw-data-table-pagination__status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {busy ? `${status} · Loading…` : status}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || !hasNext}
          onClick={onNext}
          aria-label={`Next page of ${label}`}
        >
          Next
        </button>
        {onLast ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy || !hasNext}
            onClick={onLast}
            aria-label={`Last page of ${label}`}
          >
            Last
          </button>
        ) : null}
      </div>
    </nav>
  );
}

export function DataTableLoadMore({
  label,
  loadedCount,
  totalCount,
  totalIsApproximate = false,
  hasMore,
  busy = false,
  onLoadMore,
  onJumpToEnd,
  endLabel = "End of results",
}: DataTableLoadMoreProps): ReactElement {
  const safeLoaded = Math.max(0, Math.floor(loadedCount));
  const safeTotal =
    totalCount == null ? null : Math.max(safeLoaded, Math.floor(totalCount));
  const countLabel =
    safeTotal == null
      ? `${safeLoaded.toLocaleString()} loaded`
      : `Showing ${safeLoaded.toLocaleString()} of ${
          totalIsApproximate ? "~" : ""
        }${safeTotal.toLocaleString()}`;
  return (
    <nav
      className="pw-data-table-pagination"
      aria-label={`${label} result controls`}
    >
      <span
        className="pw-data-table-pagination__summary"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {busy ? `${countLabel} · Loading more…` : countLabel}
      </span>
      <div className="pw-data-table-pagination__controls">
        {hasMore ? (
          <>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={onLoadMore}
            >
              {busy ? "Loading…" : "Load more"}
            </button>
            {onJumpToEnd ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy}
                onClick={onJumpToEnd}
              >
                Jump to end
              </button>
            ) : null}
          </>
        ) : (
          <span className="pw-data-table-pagination__status">{endLabel}</span>
        )}
      </div>
    </nav>
  );
}

interface SelectionState {
  selectableKeys: readonly string[];
  allSelected: boolean;
  someSelected: boolean;
  selectedCount: number;
}

function useSelectionState<Row>(
  rows: readonly Row[],
  rowKeys: readonly string[],
  selection: DataTableSelection<Row> | undefined,
): SelectionState | null {
  return useMemo(() => {
    if (!selection) return null;
    const selectableKeys = rowKeys.filter((_, index) => {
      const row = rows[index];
      return row !== undefined && !selection.isDisabled?.(row);
    });
    const pageSelectedCount = selectableKeys.filter((key) =>
      selection.selectedKeys.has(key),
    ).length;
    return {
      selectableKeys,
      selectedCount: selection.selectedKeys.size,
      allSelected:
        selectableKeys.length > 0 &&
        pageSelectedCount === selectableKeys.length,
      someSelected:
        pageSelectedCount > 0 && pageSelectedCount < selectableKeys.length,
    };
  }, [rowKeys, rows, selection]);
}

function ColumnHeader<Row>({
  column,
  sort,
  onSortChange,
}: {
  column: DataTableColumn<Row>;
  sort: DataTableSortState | undefined;
  onSortChange: ((sort: DataTableSortState) => void) | undefined;
}): ReactElement {
  const active = sort?.columnId === column.id;
  const ariaSort = active
    ? sort.direction === "asc"
      ? "ascending"
      : "descending"
    : "none";
  const nextDirection: DataTableSortDirection =
    active && sort.direction === "asc" ? "desc" : "asc";
  const canSort = Boolean(column.sortable && onSortChange);
  return (
    <th
      scope="col"
      className={column.className}
      data-align={column.align ?? "start"}
      aria-sort={canSort ? ariaSort : undefined}
    >
      {canSort ? (
        <button
          type="button"
          className="pw-data-table__sort"
          onClick={() =>
            onSortChange?.({ columnId: column.id, direction: nextDirection })
          }
          aria-label={`Sort by ${column.sortLabel ?? String(column.header)}, ${
            active
              ? sort.direction === "asc"
                ? "currently ascending"
                : "currently descending"
              : "not currently sorted"
          }`}
        >
          <span>{column.header}</span>
          <span aria-hidden="true">
            {active ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}
          </span>
        </button>
      ) : (
        column.header
      )}
    </th>
  );
}

function SelectionHeader<Row>({
  caption,
  selection,
  state,
}: {
  caption: string;
  selection: DataTableSelection<Row>;
  state: SelectionState;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = state.someSelected;
  }, [state.someSelected]);

  const togglePage = (event: ChangeEvent<HTMLInputElement>): void => {
    const next = new Set(selection.selectedKeys);
    for (const key of state.selectableKeys) {
      if (event.currentTarget.checked) next.add(key);
      else next.delete(key);
    }
    selection.onSelectionChange(next);
  };

  const scope = selection.scopeLabel ?? `rows in ${caption}`;
  return (
    <th scope="col" className="pw-data-table__selection-cell">
      <input
        ref={inputRef}
        type="checkbox"
        checked={state.allSelected}
        disabled={state.selectableKeys.length === 0}
        onChange={togglePage}
        aria-label={
          state.allSelected ? `Deselect all ${scope}` : `Select all ${scope}`
        }
      />
    </th>
  );
}

function SelectionCell<Row>({
  row,
  rowKey,
  selection,
}: {
  row: Row;
  rowKey: string;
  selection: DataTableSelection<Row>;
}): ReactElement {
  const disabled = selection.isDisabled?.(row) ?? false;
  return (
    <td className="pw-data-table__selection-cell">
      <input
        type="checkbox"
        checked={selection.selectedKeys.has(rowKey)}
        disabled={disabled}
        onChange={(event) => {
          const next = new Set(selection.selectedKeys);
          if (event.currentTarget.checked) next.add(rowKey);
          else next.delete(rowKey);
          selection.onSelectionChange(next);
        }}
        aria-label={`${
          selection.selectedKeys.has(rowKey) ? "Deselect" : "Select"
        } ${selection.label(row)}`}
      />
    </td>
  );
}

function StatusRow({
  columnCount,
  content,
}: {
  columnCount: number;
  content: ReactNode;
}): ReactElement {
  return (
    <tr>
      <td colSpan={Math.max(1, columnCount)} className="pw-data-table__status">
        <div role="status">{content}</div>
      </td>
    </tr>
  );
}
