export interface CustomRange {
  from: string;
  to: string;
}

export interface DayCell {
  date: Date;
  iso: string;
  inMonth: boolean;
  isToday: boolean;
}

export interface DateRangePreset {
  id: string;
  label: string;
  build: (now: Date) => CustomRange;
}

export interface AnchoredPopoverPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function fromIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

export function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function addDays(date: Date, amount: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + amount);
  return copy;
}

export function addMonths(date: Date, amount: number): Date {
  const day = date.getDate();
  const copy = new Date(date);
  copy.setDate(1);
  copy.setMonth(copy.getMonth() + amount);
  const lastDay = new Date(
    copy.getFullYear(),
    copy.getMonth() + 1,
    0,
  ).getDate();
  copy.setDate(Math.min(day, lastDay));
  return copy;
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfWeek(date: Date): Date {
  const copy = startOfDay(date);
  const weekday = copy.getDay();
  return addDays(copy, weekday === 0 ? -6 : 1 - weekday);
}

function startOfQuarter(date: Date): Date {
  return new Date(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1);
}

function startOfYear(date: Date): Date {
  return new Date(date.getFullYear(), 0, 1);
}

export const DATE_RANGE_PRESETS: readonly DateRangePreset[] = [
  {
    id: "today",
    label: "Today",
    build: (now) => ({ from: toIsoDate(now), to: toIsoDate(now) }),
  },
  {
    id: "yesterday",
    label: "Yesterday",
    build: (now) => {
      const yesterday = addDays(now, -1);
      return { from: toIsoDate(yesterday), to: toIsoDate(yesterday) };
    },
  },
  {
    id: "this-week",
    label: "This week",
    build: (now) => ({
      from: toIsoDate(startOfWeek(now)),
      to: toIsoDate(now),
    }),
  },
  {
    id: "last-week",
    label: "Last week",
    build: (now) => {
      const thisWeek = startOfWeek(now);
      return {
        from: toIsoDate(addDays(thisWeek, -7)),
        to: toIsoDate(addDays(thisWeek, -1)),
      };
    },
  },
  {
    id: "mtd",
    label: "Month to date",
    build: (now) => ({ from: toIsoDate(startOfMonth(now)), to: toIsoDate(now) }),
  },
  {
    id: "qtd",
    label: "Quarter to date",
    build: (now) => ({ from: toIsoDate(startOfQuarter(now)), to: toIsoDate(now) }),
  },
  {
    id: "ytd",
    label: "Year to date",
    build: (now) => ({ from: toIsoDate(startOfYear(now)), to: toIsoDate(now) }),
  },
  {
    id: "last-12-months",
    label: "Last 12 months",
    build: (now) => ({ from: toIsoDate(addMonths(now, -12)), to: toIsoDate(now) }),
  },
  {
    id: "last-365-days",
    label: "Last 365 days",
    build: (now) => ({ from: toIsoDate(addDays(now, -364)), to: toIsoDate(now) }),
  },
];

export function buildMonthGrid(anchor: Date, now = new Date()): DayCell[] {
  const today = toIsoDate(startOfDay(now));
  const first = startOfMonth(anchor);
  const mondayIndex = (first.getDay() + 6) % 7;
  const gridStart = addDays(first, -mondayIndex);
  const cells: DayCell[] = [];
  for (let index = 0; index < 42; index += 1) {
    const date = addDays(gridStart, index);
    const iso = toIsoDate(date);
    cells.push({
      date,
      iso,
      inMonth: date.getMonth() === anchor.getMonth(),
      isToday: iso === today,
    });
  }
  return cells;
}

export function calendarKeyboardTarget(
  current: Date,
  key: string,
  shiftKey = false,
): Date | null {
  const mondayIndex = (current.getDay() + 6) % 7;
  if (key === "ArrowLeft") return addDays(current, -1);
  if (key === "ArrowRight") return addDays(current, 1);
  if (key === "ArrowUp") return addDays(current, -7);
  if (key === "ArrowDown") return addDays(current, 7);
  if (key === "Home") return addDays(current, -mondayIndex);
  if (key === "End") return addDays(current, 6 - mondayIndex);
  if (key === "PageUp") return addMonths(current, shiftKey ? -12 : -1);
  if (key === "PageDown") return addMonths(current, shiftKey ? 12 : 1);
  return null;
}

export function monthLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function weekdayLabels(): Array<{ short: string; long: string }> {
  const monday = new Date(2026, 0, 5);
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(monday, index);
    return {
      short: date.toLocaleDateString(undefined, { weekday: "short" }),
      long: date.toLocaleDateString(undefined, { weekday: "long" }),
    };
  });
}

export function dateRangePopoverPosition(
  anchor: Pick<DOMRect, "bottom" | "left" | "right" | "top">,
  viewportWidth: number,
  viewportHeight: number,
): AnchoredPopoverPosition {
  const gutter = 8;
  const gap = 6;
  const width = Math.max(0, Math.min(620, viewportWidth - gutter * 2));
  const maximumLeft = Math.max(gutter, viewportWidth - width - gutter);
  const left = Math.max(gutter, Math.min(anchor.right - width, maximumLeft));
  const below = Math.max(0, viewportHeight - anchor.bottom - gap - gutter);
  const above = Math.max(0, anchor.top - gap - gutter);
  const preferBelow = below >= Math.min(360, viewportHeight - gutter * 2);
  const placeBelow = preferBelow || below >= above;
  return {
    left,
    top: placeBelow ? anchor.bottom + gap : gutter,
    width,
    maxHeight: placeBelow ? below : above,
  };
}

export function normalizeRange(from: string, to: string): CustomRange {
  return from <= to ? { from, to } : { from: to, to: from };
}
