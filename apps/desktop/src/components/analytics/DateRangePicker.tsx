/**
 * A non-modal, route-local date range task. The popup is portalled so its
 * geometry is independent of toolbar overflow, but it participates in the
 * shared dialog stack so Escape only affects the logical top layer.
 */

import {
  type FocusEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useDialogStack } from "../../hooks/useDialogStack";
import { popDialog, pushDialog } from "../../lib/dialogStack";
import { DateRangePopover } from "./DateRangePopover";
import {
  addMonths,
  dateRangePopoverPosition,
  fromIsoDate,
  monthLabel,
  normalizeRange,
  startOfMonth,
  toIsoDate,
  type CustomRange,
  type DateRangePreset,
} from "./date-range-picker-model";

import "../../styles-date-range-picker.css";

export type { CustomRange } from "./date-range-picker-model";

interface Props {
  value: CustomRange | null;
  onApply: (range: CustomRange) => void;
  triggerLabel?: string;
  active?: boolean;
}

type SelectionPhase = "start" | "end";

function triggerText(value: CustomRange | null, override?: string): string {
  if (override) return override;
  if (!value) return "Custom…";
  const from = fromIsoDate(value.from);
  const to = fromIsoDate(value.to);
  if (!from || !to) return `${value.from} → ${value.to}`;
  if (value.from === value.to) {
    return from.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  const sameYear = from.getFullYear() === to.getFullYear();
  const fromLabel = from.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "2-digit",
  });
  const toLabel = to.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "2-digit",
  });
  return `${fromLabel} – ${toLabel}`;
}

function visibleMonthCount(): 1 | 2 {
  return window.innerWidth <= 700 ? 1 : 2;
}

function initialDate(value: CustomRange | null): Date {
  return (value?.from && fromIsoDate(value.from)) || new Date();
}

export function DateRangePicker({
  value,
  onApply,
  triggerLabel,
  active,
}: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(() => startOfMonth(initialDate(value)));
  const [focusedIso, setFocusedIso] = useState(() => toIsoDate(initialDate(value)));
  const [visibleMonths, setVisibleMonths] = useState<1 | 2>(visibleMonthCount);
  const [draftStart, setDraftStart] = useState<string | null>(null);
  const [draftEnd, setDraftEnd] = useState<string | null>(null);
  const [phase, setPhase] = useState<SelectionPhase>("start");
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [, setPositionRevision] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const shouldFocusDayRef = useRef(false);
  const popoverId = useId();
  const headingId = useId();
  const statusId = useId();
  const dialogId = useId();
  const { isTop } = useDialogStack(dialogId);

  const closePicker = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    setHoverDate(null);
    setPhase("start");
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    pushDialog(dialogId);
    return () => popDialog(dialogId);
  }, [dialogId, open]);

  useEffect(() => {
    if (!open || !isTop) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229 || event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      closePicker(true);
      setAnnouncement("Date range selection cancelled.");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closePicker, isTop, open]);

  useEffect(() => {
    if (!open) return;
    let frame: number | null = null;
    const refresh = (): void => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setPositionRevision((revision) => revision + 1);
        setVisibleMonths(visibleMonthCount());
      });
    };
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      closePicker(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [closePicker, open]);

  useEffect(() => {
    if (!open || !shouldFocusDayRef.current) return;
    shouldFocusDayRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      popoverRef.current
        ?.querySelector<HTMLButtonElement>(`[data-date="${focusedIso}"]`)
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [anchor, focusedIso, open, visibleMonths]);

  useEffect(() => {
    if (!open) return;
    const focused = fromIsoDate(focusedIso);
    if (!focused) return;
    const lastVisible = addMonths(anchor, visibleMonths - 1);
    const focusedMonth = startOfMonth(focused).getTime();
    if (
      focusedMonth < anchor.getTime() ||
      focusedMonth > startOfMonth(lastVisible).getTime()
    ) {
      setAnchor(startOfMonth(focused));
    }
  }, [anchor, focusedIso, open, visibleMonths]);

  const openPicker = (): void => {
    const basis = initialDate(value);
    setAnchor(startOfMonth(basis));
    setFocusedIso(toIsoDate(basis));
    setVisibleMonths(visibleMonthCount());
    setDraftStart(value?.from ?? null);
    setDraftEnd(value?.to ?? null);
    setPhase("start");
    setHoverDate(null);
    shouldFocusDayRef.current = true;
    setOpen(true);
  };

  const selectDay = (iso: string): void => {
    if (phase === "start") {
      setDraftStart(iso);
      setDraftEnd(null);
      setPhase("end");
      setAnnouncement(`Start date ${iso} selected. Choose an end date.`);
      return;
    }
    setDraftEnd(iso);
    setPhase("start");
    setAnnouncement(`End date ${iso} selected. Review and apply the range.`);
  };

  const moveCalendarFocus = (date: Date): void => {
    const iso = toIsoDate(date);
    const targetMonth = startOfMonth(date);
    const lastVisible = startOfMonth(addMonths(anchor, visibleMonths - 1));
    if (
      targetMonth.getTime() < anchor.getTime() ||
      targetMonth.getTime() > lastVisible.getTime()
    ) {
      setAnchor(targetMonth);
    }
    shouldFocusDayRef.current = true;
    setFocusedIso(iso);
  };

  const shiftVisibleMonth = (amount: number): void => {
    const nextAnchor = startOfMonth(addMonths(anchor, amount));
    const focused = fromIsoDate(focusedIso) ?? anchor;
    setAnchor(nextAnchor);
    setFocusedIso(toIsoDate(addMonths(focused, amount)));
    setAnnouncement(`Showing ${monthLabel(nextAnchor)}.`);
  };

  const applyRange = (): void => {
    if (!draftStart || !draftEnd) return;
    const range = normalizeRange(draftStart, draftEnd);
    onApply(range);
    setAnnouncement(`Date range ${range.from} through ${range.to} applied.`);
    closePicker(true);
  };

  const applyPreset = (preset: DateRangePreset): void => {
    const range = preset.build(new Date());
    onApply(range);
    setAnnouncement(`${preset.label}: ${range.from} through ${range.to} applied.`);
    closePicker(true);
  };

  const handlePopoverBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as Node | null;
    if (next && popoverRef.current?.contains(next)) return;
    if (next && triggerRef.current?.contains(next)) return;
    window.requestAnimationFrame(() => {
      const activeElement = document.activeElement;
      if (activeElement && popoverRef.current?.contains(activeElement)) return;
      closePicker(false);
    });
  };

  const visualFrom = draftStart;
  const visualTo = phase === "end" ? hoverDate ?? draftEnd ?? draftStart : draftEnd;
  const visualRange =
    visualFrom && visualTo ? normalizeRange(visualFrom, visualTo) : null;
  const instruction = draftStart
    ? draftEnd
      ? `${draftStart} through ${draftEnd}. Review and apply.`
      : `${draftStart} selected. Choose an end date.`
    : "Choose a start date.";
  const rect = triggerRef.current?.getBoundingClientRect() ?? {
    bottom: 8,
    left: 8,
    right: 8,
    top: 8,
  };
  const position = dateRangePopoverPosition(
    rect,
    window.innerWidth,
    window.innerHeight,
  );

  return (
    <div className="date-range-picker">
      <button
        ref={triggerRef}
        type="button"
        className={`chip${active ? " is-active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={
          value
            ? `Custom date range, ${value.from} through ${value.to}`
            : "Choose a custom date range"
        }
        onClick={() => (open ? closePicker(false) : openPicker())}
      >
        {triggerText(value, triggerLabel)}
      </button>
      <span id={statusId} className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </span>
      {open
        ? createPortal(
            <DateRangePopover
              anchor={anchor}
              draftEnd={draftEnd}
              draftStart={draftStart}
              focusedIso={focusedIso}
              headingId={headingId}
              instruction={instruction}
              popoverId={popoverId}
              popoverRef={popoverRef}
              position={position}
              statusId={statusId}
              visibleMonths={visibleMonths}
              visualLo={visualRange?.from ?? visualFrom}
              visualHi={visualRange?.to ?? visualFrom}
              onApply={applyRange}
              onBlur={handlePopoverBlur}
              onCancel={() => {
                setAnnouncement("Date range selection cancelled.");
                closePicker(true);
              }}
              onDayClick={selectDay}
              onDayFocus={setFocusedIso}
              onDraftStart={(iso) => {
                setDraftStart(iso);
                setPhase("end");
              }}
              onDraftEnd={(iso) => {
                setDraftEnd(iso);
                setPhase("start");
              }}
              onHover={setHoverDate}
              onMoveFocus={moveCalendarFocus}
              onPreset={applyPreset}
              onShiftMonth={shiftVisibleMonth}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
