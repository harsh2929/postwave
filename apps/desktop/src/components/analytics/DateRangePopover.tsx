import {
  type FocusEvent,
  type ReactElement,
  type RefObject,
} from "react";

import { DateRangeCalendar } from "./DateRangeCalendar";
import {
  DATE_RANGE_PRESETS,
  fromIsoDate,
  type AnchoredPopoverPosition,
  type DateRangePreset,
} from "./date-range-picker-model";

interface Props {
  anchor: Date;
  draftEnd: string | null;
  draftStart: string | null;
  focusedIso: string;
  headingId: string;
  instruction: string;
  popoverId: string;
  popoverRef: RefObject<HTMLDivElement | null>;
  position: AnchoredPopoverPosition;
  statusId: string;
  visibleMonths: 1 | 2;
  visualHi: string | null;
  visualLo: string | null;
  onApply: () => void;
  onBlur: (event: FocusEvent<HTMLDivElement>) => void;
  onCancel: () => void;
  onDayClick: (iso: string) => void;
  onDayFocus: (iso: string) => void;
  onDraftEnd: (iso: string) => void;
  onDraftStart: (iso: string) => void;
  onHover: (iso: string | null) => void;
  onMoveFocus: (date: Date) => void;
  onPreset: (preset: DateRangePreset) => void;
  onShiftMonth: (amount: number) => void;
}

export function DateRangePopover({
  anchor,
  draftEnd,
  draftStart,
  focusedIso,
  headingId,
  instruction,
  popoverId,
  popoverRef,
  position,
  statusId,
  visibleMonths,
  visualHi,
  visualLo,
  onApply,
  onBlur,
  onCancel,
  onDayClick,
  onDayFocus,
  onDraftEnd,
  onDraftStart,
  onHover,
  onMoveFocus,
  onPreset,
  onShiftMonth,
}: Props): ReactElement {
  return (
    <div
      ref={popoverRef}
      id={popoverId}
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      aria-describedby={statusId}
      className="date-range-popover"
      style={position}
      onBlurCapture={onBlur}
    >
      <h2 id={headingId} className="visually-hidden">
        Choose a date range
      </h2>
      <div
        role="group"
        aria-label="Quick date ranges"
        className="date-range-presets"
      >
        <span className="date-range-presets-title">Quick presets</span>
        {DATE_RANGE_PRESETS.map((preset) => (
          <button
            type="button"
            className="date-range-preset"
            onClick={() => onPreset(preset)}
            key={preset.id}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <div className="date-range-calendar-panel">
        <div className="date-range-toolbar">
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Show previous month"
            onClick={() => onShiftMonth(-1)}
          >
            ‹
          </button>
          <p className="date-range-instruction">{instruction}</p>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Show next month"
            onClick={() => onShiftMonth(1)}
          >
            ›
          </button>
        </div>
        <DateRangeCalendar
          anchor={anchor}
          focusedIso={focusedIso}
          visibleMonths={visibleMonths}
          visualLo={visualLo}
          visualHi={visualHi}
          onDayClick={onDayClick}
          onDayFocus={onDayFocus}
          onHover={onHover}
          onMoveFocus={onMoveFocus}
        />
        <div className="date-range-footer">
          <label className="date-range-input-label">
            <span>From</span>
            <input
              type="date"
              className="input"
              value={draftStart ?? ""}
              onChange={(event) => {
                if (fromIsoDate(event.target.value)) onDraftStart(event.target.value);
              }}
            />
          </label>
          <label className="date-range-input-label">
            <span>To</span>
            <input
              type="date"
              className="input"
              value={draftEnd ?? ""}
              onChange={(event) => {
                if (fromIsoDate(event.target.value)) onDraftEnd(event.target.value);
              }}
            />
          </label>
          <span className="date-range-footer-spacer" />
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!draftStart || !draftEnd}
            onClick={onApply}
          >
            Apply range
          </button>
        </div>
      </div>
    </div>
  );
}
