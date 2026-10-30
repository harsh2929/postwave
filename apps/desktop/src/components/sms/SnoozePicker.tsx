/**
 * SnoozePicker — small popover with canned snooze durations (1h /
 * 4h / 8h / tomorrow / next week). Refined SMS Inbox PR 2.
 *
 * Pure presentation; the parent translates the picked duration into
 * an ISO timestamp and posts to /snooze. Keeping the math in the
 * parent means tests can pin time without mocking the picker.
 */

import { type ReactElement, useId, useRef, useState } from "react";

import { useMenuInteraction } from "../../hooks/useMenuInteraction";

interface Props {
  onPick: (until: Date) => void;
  /** Label override for the trigger button. Default "Snooze". */
  label?: string;
  disabled?: boolean;
}

const PRESETS: Array<{ label: string; addMs: number }> = [
  { label: "1 hour", addMs: 60 * 60_000 },
  { label: "4 hours", addMs: 4 * 60 * 60_000 },
  { label: "8 hours", addMs: 8 * 60 * 60_000 },
  { label: "Tomorrow 9am", addMs: -1 }, // sentinel — handled in onPick
  { label: "Next Monday", addMs: -2 },
];

function resolvePreset(addMs: number): Date {
  const now = new Date();
  if (addMs === -1) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  }
  if (addMs === -2) {
    const d = new Date(now);
    const dayOfWeek = d.getDay(); // 0=Sun..6=Sat
    const daysToMonday = (1 + 7 - dayOfWeek) % 7 || 7;
    d.setDate(d.getDate() + daysToMonday);
    d.setHours(9, 0, 0, 0);
    return d;
  }
  return new Date(now.getTime() + addMs);
}

export function SnoozePicker({
  onPick,
  label = "Snooze",
  disabled = false,
}: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  useMenuInteraction({
    menuRef,
    onClose: () => setOpen(false),
    open,
    trigger: triggerRef.current,
  });
  return (
    <div className="sms-snooze-picker">
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        {label} {open ? "▾" : "▸"}
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          className="sms-snooze-popover"
          role="menu"
          aria-label="Snooze duration"
        >
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="sms-snooze-option"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                onPick(resolvePreset(p.addMs));
                setOpen(false);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
