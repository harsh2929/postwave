import {
  type CSSProperties,
  type FocusEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

export interface WindowedListRange {
  first: number;
  last: number;
  loaded: number;
  total: number;
}

export interface WindowedListProps<Item> {
  label: string;
  items: readonly Item[];
  getKey: (item: Item) => string;
  renderItem: (item: Item, index: number) => ReactNode;
  height: number;
  itemHeight: number;
  totalCount?: number | null;
  itemOffset?: number;
  overscan?: number;
  emptyState?: ReactNode;
  className?: string;
  style?: CSSProperties;
  onRangeChange?: (range: WindowedListRange) => void;
  externalScrollRef?: { current: HTMLDivElement | null };
}

/**
 * Fixed-row virtualization with explicit assistive-technology position data.
 *
 * The currently focused row remains mounted even after it leaves the visual
 * window. This prevents scroll or live-data insertion from destroying focus;
 * it costs at most one additional DOM row.
 */
export function WindowedList<Item>({
  label,
  items,
  getKey,
  renderItem,
  height,
  itemHeight,
  totalCount,
  itemOffset = 0,
  overscan = 6,
  emptyState = "No items available.",
  className,
  style,
  onRangeChange,
  externalScrollRef,
}: WindowedListProps<Item>): ReactElement {
  const descriptionId = useId();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  const safeItemHeight = Math.max(1, itemHeight);
  const safeHeight = Math.max(safeItemHeight, height);
  const safeOverscan = Math.max(0, Math.floor(overscan));
  const resolvedTotal = Math.max(items.length, totalCount ?? items.length);
  const visibleStart = Math.min(
    Math.max(0, items.length - 1),
    Math.floor(scrollTop / safeItemHeight),
  );
  const visibleCount = Math.ceil(safeHeight / safeItemHeight);
  const visibleEnd = Math.min(items.length, visibleStart + visibleCount);
  const windowStart = Math.max(0, visibleStart - safeOverscan);
  const windowEnd = Math.min(items.length, visibleEnd + safeOverscan);
  const focusedIndex = useMemo(
    () =>
      focusedKey == null
        ? -1
        : items.findIndex((item) => getKey(item) === focusedKey),
    [focusedKey, getKey, items],
  );
  const indices = useMemo(() => {
    const next = Array.from(
      { length: Math.max(0, windowEnd - windowStart) },
      (_, offset) => windowStart + offset,
    );
    if (
      focusedIndex >= 0 &&
      focusedIndex < items.length &&
      !next.includes(focusedIndex)
    ) {
      next.push(focusedIndex);
      next.sort((left, right) => left - right);
    }
    return next;
  }, [focusedIndex, items.length, windowEnd, windowStart]);

  useEffect(() => {
    if (!onRangeChange || items.length === 0) return;
    onRangeChange({
      first: itemOffset + visibleStart + 1,
      last: itemOffset + Math.max(visibleStart + 1, visibleEnd),
      loaded: items.length,
      total: resolvedTotal,
    });
  }, [
    itemOffset,
    items.length,
    onRangeChange,
    resolvedTotal,
    visibleEnd,
    visibleStart,
  ]);

  useEffect(() => {
    const maxScroll = Math.max(0, items.length * safeItemHeight - safeHeight);
    if (scrollTop <= maxScroll) return;
    setScrollTop(maxScroll);
    if (scrollRef.current) scrollRef.current.scrollTop = maxScroll;
  }, [items.length, safeHeight, safeItemHeight, scrollTop]);

  if (items.length === 0) {
    return (
      <div className="pw-windowed-list__empty" role="status">
        {emptyState}
      </div>
    );
  }

  return (
    <div
      ref={(element) => {
        scrollRef.current = element;
        if (externalScrollRef) externalScrollRef.current = element;
      }}
      className={`pw-windowed-list${className ? ` ${className}` : ""}`}
      style={{ height: safeHeight, ...style }}
      role="list"
      aria-label={label}
      aria-describedby={descriptionId}
      data-windowed-count={indices.length}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      // A labelled overflow region must itself be keyboard-scrollable.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
    >
      <span id={descriptionId} className="visually-hidden">
        Virtualized list. Items expose their position in the complete result.
      </span>
      <div
        className="pw-windowed-list__spacer"
        style={{ height: items.length * safeItemHeight }}
        aria-hidden="true"
      />
      {indices.map((index) => {
        const item = items[index];
        if (item === undefined) return null;
        const key = getKey(item);
        return (
          <div
            key={key}
            className="pw-windowed-list__item"
            role="listitem"
            aria-posinset={itemOffset + index + 1}
            aria-setsize={resolvedTotal}
            style={{
              height: safeItemHeight,
              transform: `translateY(${index * safeItemHeight}px)`,
            }}
            onFocusCapture={() => setFocusedKey(key)}
            onBlurCapture={(event) =>
              clearFocusedKeyWhenLeaving(event, key, setFocusedKey)
            }
          >
            {renderItem(item, index)}
          </div>
        );
      })}
    </div>
  );
}

function clearFocusedKeyWhenLeaving(
  event: FocusEvent<HTMLDivElement>,
  key: string,
  setFocusedKey: (update: (current: string | null) => string | null) => void,
): void {
  const next = event.relatedTarget;
  if (next instanceof Node && event.currentTarget.contains(next)) return;
  setFocusedKey((current) => (current === key ? null : current));
}
