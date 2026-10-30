import {
  type KeyboardEvent,
  type ReactElement,
  useId,
  useMemo,
} from "react";

import {
  addMonths,
  buildMonthGrid,
  calendarKeyboardTarget,
  monthLabel,
  toIsoDate,
  weekdayLabels,
  type DayCell,
} from "./date-range-picker-model";

interface Props {
  anchor: Date;
  focusedIso: string;
  visibleMonths: 1 | 2;
  visualLo: string | null;
  visualHi: string | null;
  onDayClick: (iso: string) => void;
  onDayFocus: (iso: string) => void;
  onHover: (iso: string | null) => void;
  onMoveFocus: (date: Date) => void;
}

const WEEKDAYS = weekdayLabels();

function dayAccessibleName(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function weeks(cells: DayCell[]): DayCell[][] {
  const rows: DayCell[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    rows.push(cells.slice(index, index + 7));
  }
  return rows;
}

export function DateRangeCalendar({
  anchor,
  focusedIso,
  visibleMonths,
  visualLo,
  visualHi,
  onDayClick,
  onDayFocus,
  onHover,
  onMoveFocus,
}: Props): ReactElement {
  const firstHeadingId = useId();
  const secondHeadingId = useId();
  const monthAnchors = useMemo(
    () =>
      visibleMonths === 1 ? [anchor] : [anchor, addMonths(anchor, 1)],
    [anchor, visibleMonths],
  );

  const handleDayKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    date: Date,
  ): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const target = calendarKeyboardTarget(date, event.key, event.shiftKey);
    if (!target) return;
    event.preventDefault();
    onMoveFocus(target);
  };

  return (
    <div className="date-range-calendars">
      {monthAnchors.map((month, monthIndex) => {
        const headingId = monthIndex === 0 ? firstHeadingId : secondHeadingId;
        return (
          <section className="date-range-month" key={toIsoDate(month)}>
            <h3 id={headingId} className="date-range-month-title">
              {monthLabel(month)}
            </h3>
            <div
              role="grid"
              aria-labelledby={headingId}
              aria-multiselectable="true"
              className="date-range-grid"
            >
              <div role="row" className="date-range-weekdays">
                {WEEKDAYS.map((weekday) => (
                  <span
                    role="columnheader"
                    aria-label={weekday.long}
                    className="date-range-weekday"
                    key={weekday.long}
                  >
                    {weekday.short}
                  </span>
                ))}
              </div>
              {weeks(buildMonthGrid(month)).map((week, weekIndex) => (
                <div role="row" className="date-range-week" key={weekIndex}>
                  {week.map((cell) => {
                    if (!cell.inMonth) {
                      return (
                        <span
                          role="gridcell"
                          aria-hidden="true"
                          className="date-range-day-placeholder"
                          key={cell.iso}
                        />
                      );
                    }
                    const inRange =
                      visualLo != null &&
                      visualHi != null &&
                      cell.iso >= visualLo &&
                      cell.iso <= visualHi;
                    const isEdge =
                      cell.iso === visualLo || cell.iso === visualHi;
                    return (
                      <button
                        role="gridcell"
                        type="button"
                        className="date-range-day"
                        data-date={cell.iso}
                        data-in-range={inRange ? "true" : undefined}
                        data-range-edge={isEdge ? "true" : undefined}
                        tabIndex={cell.iso === focusedIso ? 0 : -1}
                        aria-label={dayAccessibleName(cell.date)}
                        aria-selected={inRange}
                        aria-current={cell.isToday ? "date" : undefined}
                        onClick={() => onDayClick(cell.iso)}
                        onFocus={() => onDayFocus(cell.iso)}
                        onKeyDown={(event) => handleDayKey(event, cell.date)}
                        onPointerEnter={() => onHover(cell.iso)}
                        onPointerLeave={() => onHover(null)}
                        key={cell.iso}
                      >
                        {cell.date.getDate()}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
