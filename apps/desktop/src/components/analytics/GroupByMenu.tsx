/**
 * GroupByMenu — toolbar dropdown that picks the active breakdown
 * dimension for the whole Analytics page.
 *
 * Seven dimensions live behind the menu: campaign, domain, list,
 * segment, country, mail-client, device. "None" is the eighth entry
 * (and the default).
 *
 * The component is presentational — it owns nothing beyond its open
 * state. The page above decides what each dimension means. On the
 * Analytics page today, campaign and domain drive per-group time
 * series via GET /api/v1/analytics/timeseries (see
 * GroupedTimeseriesChart); the remaining dimensions are disabled via
 * `unavailable` until the page can chart them.
 *
 * Dimensions that genuinely cannot be broken down are DISABLED, not
 * hidden, so the affordance stays consistent across roles and visible,
 * focusable help explains why instead of synthesising fake series:
 *   - `list` is always disabled: engagement events carry no list
 *     attribution (the server 400s with `unsupported_dimension`).
 *   - callers disable more via `unavailable` (segment, country,
 *     mail-client, device on the Analytics page).
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

import { useDialogStack } from "../../hooks/useDialogStack";
import { useMenuInteraction } from "../../hooks/useMenuInteraction";
import { popDialog, pushDialog } from "../../lib/dialogStack";

import "../../styles-analytics-popups.css";

export type GroupByDimension =
  | "none"
  | "campaign"
  | "domain"
  | "list"
  | "segment"
  | "country"
  | "mail-client"
  | "device";

interface Props {
  value: GroupByDimension;
  onChange: (next: GroupByDimension) => void;
  /**
   * Extra dimensions the caller wants disabled (beyond the always-
   * disabled `list`) — e.g. segment, whose per-campaign attribution
   * the backend doesn't surface today. Disabled rows render with a
   * "no data" chip and don't fire onChange, so the page never has to
   * fake a breakdown it can't draw.
   */
  unavailable?: GroupByDimension[];
}

interface Option {
  value: GroupByDimension;
  label: string;
  hint: string;
  /**
   * Set when the backend fundamentally cannot provide this breakdown
   * (vs. caller-driven `unavailable`). The reason is rendered visibly
   * and connected to the focusable disabled menu item.
   */
  disabledReason?: string;
}

const OPTIONS: Option[] = [
  { value: "none", label: "None", hint: "Aggregate view" },
  { value: "campaign", label: "Campaign", hint: "One series per campaign" },
  { value: "domain", label: "Domain", hint: "One series per sending domain" },
  {
    value: "list",
    label: "List",
    hint: "Audience container",
    disabledReason:
      "Events carry no list attribution — the backend can't break engagement down by list.",
  },
  { value: "segment", label: "Segment", hint: "Saved filter" },
  { value: "country", label: "Country", hint: "Opens by geography" },
  { value: "mail-client", label: "Mail client", hint: "Gmail vs Outlook etc" },
  { value: "device", label: "Device", hint: "Mobile vs desktop" },
];

const LABEL_BY_VALUE: Record<GroupByDimension, string> = OPTIONS.reduce(
  (acc, o) => {
    acc[o.value] = o.label;
    return acc;
  },
  {} as Record<GroupByDimension, string>,
);

/** Public helper so callers (Analytics page) can format the active
 *  selection without duplicating the option map. */
export function groupByLabel(d: GroupByDimension): string {
  return LABEL_BY_VALUE[d];
}

/** Visible explanation for rows the page disables via `unavailable`. */
const CALLER_UNAVAILABLE_TITLE =
  "The grouped time-series endpoint only supports campaign and sending-domain breakdowns today — this dimension can't be charted yet.";

const GROUP_ITEM_SELECTOR = '[role="menuitemradio"]';

export function GroupByMenu(props: Props): ReactElement {
  const { value, onChange, unavailable = [] } = props;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const triggerId = useId();
  const { isTop } = useDialogStack(menuId);

  const closeMenu = useCallback((restoreFocus = false): void => {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    pushDialog(menuId);
    return () => popDialog(menuId);
  }, [menuId, open]);

  useMenuInteraction({
    isTop,
    itemSelector: GROUP_ITEM_SELECTOR,
    menuRef,
    onClose: closeMenu,
    open,
    selectedItemSelector:
      '[role="menuitemradio"][aria-checked="true"]',
    trigger: triggerRef.current,
  });

  function handleMenuBlur(event: FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget as Node | null;
    if (next && menuRef.current?.contains(next)) return;
    window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && menuRef.current?.contains(active)) return;
      closeMenu(false);
    });
  }

  const isGrouped = value !== "none";
  const buttonLabel = isGrouped
    ? `Group by · ${LABEL_BY_VALUE[value]}`
    : "Group by ▾";

  return (
    <div className="analytics-popup-anchor">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={`btn btn-sm${isGrouped ? " is-active" : ""}`}
        onClick={() => (open ? closeMenu(false) : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        // Tint the button when a non-none dimension is active so the
        // operator can see the page is in grouped-mode at a glance.
        style={
          isGrouped
            ? {
                background:
                  "color-mix(in srgb, var(--pw-accent) 18%, var(--pw-bg-elev-2))",
                color: "var(--pw-fg)",
              }
            : undefined
        }
      >
        {buttonLabel}
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          className="analytics-popup analytics-popup--group"
          onBlurCapture={handleMenuBlur}
        >
          {OPTIONS.map((opt) => {
            const isActive = opt.value === value;
            const isUnavail =
              opt.disabledReason != null || unavailable.includes(opt.value);
            const unavailTitle =
              opt.disabledReason ??
              (isUnavail ? CALLER_UNAVAILABLE_TITLE : undefined);
            const reasonId = `${menuId}-${opt.value}-reason`;
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                aria-checked={isActive}
                aria-disabled={isUnavail || undefined}
                aria-describedby={isUnavail ? reasonId : undefined}
                onClick={() => {
                  if (isUnavail) return;
                  onChange(opt.value);
                  closeMenu(true);
                }}
                className="analytics-menu-item analytics-group-option"
              >
                <span>
                  <span className="analytics-group-option-label">
                    {opt.label}
                    {isActive ? (
                      <span
                        aria-hidden
                        style={{ marginLeft: 6, color: "var(--pw-accent)" }}
                      >
                        ✓
                      </span>
                    ) : null}
                  </span>
                  <span className="analytics-group-option-hint">
                    {opt.hint}
                  </span>
                  {isUnavail ? (
                    <span id={reasonId} className="analytics-group-option-reason">
                      Unavailable: {unavailTitle}
                    </span>
                  ) : null}
                </span>
                {isUnavail ? (
                  <span className="analytics-group-option-state">
                    unavailable
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
