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
import { useMenuInteraction } from "../../hooks/useMenuInteraction";
import { anchoredPopoverPosition } from "../../lib/anchored-popover-position";
import { popDialog, pushDialog } from "../../lib/dialogStack";

export interface ColumnDef {
  key: string;
  label: string;
  width: string;
  required?: boolean;
  /** Right-align + tabular-nums this column (counts / scores / metrics). */
  numeric?: boolean;
}

interface ColumnPickerProps {
  catalog: readonly ColumnDef[];
  visible: string[];
  onChange: (next: string[]) => void;
}

const COLUMN_ITEM_SELECTOR = '[role="menuitemcheckbox"]';

// SUB-075: a true checkbox menu for the Subscribers list. Required columns
// remain focusable so keyboard and assistive-technology users can reach the
// same explanation that pointer users see.
export function ColumnPicker({
  catalog,
  visible,
  onChange,
}: ColumnPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [, setPositionRevision] = useState(0);
  const [activeKey, setActiveKey] = useState<string | null>(
    catalog[0]?.key ?? null,
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const triggerId = useId();
  const { isTop } = useDialogStack(menuId);
  const closeMenu = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    pushDialog(menuId);
    return () => popDialog(menuId);
  }, [menuId, open]);

  useEffect(() => {
    if (!open) return;
    if (!activeKey || !catalog.some((column) => column.key === activeKey)) {
      setActiveKey(catalog[0]?.key ?? null);
    }
  }, [activeKey, catalog, open]);

  useEffect(() => {
    if (!open) return;
    let frame: number | null = null;
    const refreshPosition = (): void => {
      if (frame !== null) return;
      frame = -1;
      const requestedFrame = window.requestAnimationFrame(() => {
        frame = null;
        setPositionRevision((revision) => revision + 1);
      });
      if (frame !== null) frame = requestedFrame;
    };
    refreshPosition();
    window.addEventListener("resize", refreshPosition);
    window.addEventListener("scroll", refreshPosition, true);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", refreshPosition);
      window.removeEventListener("scroll", refreshPosition, true);
    };
  }, [open]);

  useMenuInteraction({
    isTop,
    itemSelector: COLUMN_ITEM_SELECTOR,
    menuRef,
    onClose: closeMenu,
    open,
    selectedItemSelector: '[data-roving-current="true"]',
    trigger: triggerRef.current,
  });

  const visibleSet = new Set(visible);
  const toggle = (key: string): void => {
    if (visibleSet.has(key)) visibleSet.delete(key);
    else visibleSet.add(key);
    onChange(
      catalog
        .filter((column) => visibleSet.has(column.key))
        .map((column) => column.key),
    );
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as Node | null;
    if (
      next &&
      (menuRef.current?.contains(next) || triggerRef.current?.contains(next))
    ) {
      return;
    }
    window.requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (!menu) return;
      const active = document.activeElement;
      if (
        (active && menu.contains(active)) ||
        (active && triggerRef.current?.contains(active))
      ) {
        return;
      }
      closeMenu();
    });
  };

  const anchor = triggerRef.current?.getBoundingClientRect() ?? {
    bottom: 8,
    left: 8,
    right: 8,
    top: 8,
  };
  const position = anchoredPopoverPosition(
    anchor,
    window.innerWidth,
    window.innerHeight,
    {
      align: "end",
      preferredWidth: 240,
      minimumHeight: 180,
    },
  );

  return (
    <div style={{ display: "inline-flex" }}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="btn btn-sm"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          ) {
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Choose visible columns"
      >
        Columns
        <span aria-hidden="true" style={{ marginLeft: 4 }}>
          ▾
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-labelledby={triggerId}
              onBlurCapture={handleBlur}
              style={{
                ...position,
                background: "var(--pw-bg-elev)",
                border: "1px solid var(--pw-border)",
                borderRadius: 4,
                boxShadow:
                  "0 4px 12px color-mix(in srgb, var(--pw-shadow-color) 20%, transparent)",
                padding: 6,
                zIndex: "var(--pw-layer-popover, 400)",
                display: "flex",
                flexDirection: "column",
                gap: 2,
                overflowY: "auto",
              }}
            >
              {catalog.map((column, index) => {
                const checked = visibleSet.has(column.key) || !!column.required;
                const locked = !!column.required;
                const reasonId = `${menuId}-${column.key}-reason`;
                const roving =
                  column.key === activeKey ||
                  (activeKey == null && index === 0);
                return (
                  <button
                    key={column.key}
                    type="button"
                    role="menuitemcheckbox"
                    tabIndex={roving ? 0 : -1}
                    data-roving-current={roving ? "true" : undefined}
                    aria-label={column.label}
                    aria-checked={checked}
                    aria-disabled={locked || undefined}
                    aria-describedby={locked ? reasonId : undefined}
                    onFocus={() => setActiveKey(column.key)}
                    onClick={() => {
                      if (!locked) toggle(column.key);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "5px 6px",
                      border: "1px solid transparent",
                      borderRadius: 3,
                      cursor: locked ? "not-allowed" : "pointer",
                      opacity: locked ? 0.72 : 1,
                      fontSize: 12,
                      color: "var(--pw-fg)",
                      background: "transparent",
                      textAlign: "left",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 14,
                        height: 14,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flex: "0 0 auto",
                        border: "1px solid var(--pw-border)",
                        borderRadius: 3,
                        background: checked
                          ? "var(--pw-accent)"
                          : "transparent",
                        color: "var(--pw-accent-contrast, white)",
                        fontSize: 10,
                        lineHeight: 1,
                      }}
                    >
                      {checked ? "✓" : ""}
                    </span>
                    <span style={{ flex: 1 }}>{column.label}</span>
                    {locked ? (
                      <>
                        <span
                          className="muted"
                          aria-hidden="true"
                          style={{ fontSize: 10 }}
                        >
                          Required
                        </span>
                        <span id={reasonId} className="visually-hidden">
                          This column is required and can&apos;t be hidden.
                        </span>
                      </>
                    ) : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
