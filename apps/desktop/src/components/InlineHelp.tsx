/**
 * InlineHelp — compact, portalled help tooltip.
 *
 * Hover and keyboard focus provide transient access. A click pins the tooltip
 * until a second click, blur, or Escape so the focus event that precedes a
 * pointer click cannot accidentally close it again.
 */

import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

interface Props {
  text: string;
  ariaLabel?: string;
}

export function InlineHelp({ text, ariaLabel }: Props): ReactElement {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerHoveredRef = useRef(false);
  const tooltipHoveredRef = useRef(false);
  const triggerFocusedRef = useRef(false);
  const pinnedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ top: 0, left: 0 });

  const cancelClose = useCallback((): void => {
    if (closeTimerRef.current == null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const show = useCallback((): void => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  const hide = useCallback((): void => {
    cancelClose();
    tooltipHoveredRef.current = false;
    setOpen(false);
  }, [cancelClose]);

  const scheduleTransientClose = useCallback((): void => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      if (
        !triggerHoveredRef.current &&
        !tooltipHoveredRef.current &&
        !triggerFocusedRef.current &&
        !pinnedRef.current
      ) {
        setOpen(false);
      }
    }, 100);
  }, [cancelClose]);

  const place = useCallback((): void => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;
    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const gutter = 8;
    const halfWidth = Math.min(tooltipRect.width / 2, 130);
    const left = Math.max(
      gutter + halfWidth,
      Math.min(
        window.innerWidth - gutter - halfWidth,
        triggerRect.left + triggerRect.width / 2,
      ),
    );
    const above = triggerRect.top >= tooltipRect.height + gutter * 2;
    setPosition({
      left,
      top: above
        ? triggerRect.top - tooltipRect.height - 6
        : triggerRect.bottom + 6,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const update = (): void => place();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, place]);

  useEffect(
    () => () => {
      cancelClose();
    },
    [cancelClose],
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="inline-help"
        aria-label={ariaLabel ?? "More information"}
        aria-describedby={tooltipId}
        onFocus={() => {
          triggerFocusedRef.current = true;
          show();
        }}
        onBlur={() => {
          triggerFocusedRef.current = false;
          pinnedRef.current = false;
          scheduleTransientClose();
        }}
        onMouseEnter={() => {
          triggerHoveredRef.current = true;
          show();
        }}
        onMouseLeave={() => {
          triggerHoveredRef.current = false;
          scheduleTransientClose();
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (pinnedRef.current) {
            pinnedRef.current = false;
            hide();
            return;
          }
          pinnedRef.current = true;
          show();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            pinnedRef.current = false;
            hide();
          }
        }}
      >
        i
      </button>
      {typeof document !== "undefined"
        ? createPortal(
            <span
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              className="inline-help-tooltip"
              data-open={open ? "true" : "false"}
              style={position}
              onMouseEnter={() => {
                tooltipHoveredRef.current = true;
                show();
              }}
              onMouseLeave={() => {
                tooltipHoveredRef.current = false;
                scheduleTransientClose();
              }}
            >
              {text}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
