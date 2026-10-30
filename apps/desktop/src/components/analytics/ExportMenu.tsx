/**
 * ExportMenu — small dropdown next to Refresh.
 *
 * Two actions:
 *   - "Print as PDF" → window.print(). Pairs with print-friendly CSS
 *     (handled inline below via a scoped <style> block that hides the
 *     sidebar and chip controls during print).
 *   - "Download stats snapshot (CSV)" → builds a one-row CSV from the
 *     dashboard stats payload + recent campaign reports passed in.
 *
 * Per-campaign CSV downloads live on each campaign's drill-down
 * slideover (the API endpoint is campaign-scoped). The export menu
 * here is for tenant-wide rollups.
 */

import {
  type FocusEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useDialogStack } from "../../hooks/useDialogStack";
import { useMenuInteraction } from "../../hooks/useMenuInteraction";
import type {
  CampaignReport,
  DashboardStatsResponse,
} from "../../lib/api-client";
import { popDialog, pushDialog } from "../../lib/dialogStack";
import { toast } from "../Toast";

import "../../styles-analytics-popups.css";

interface Props {
  stats: DashboardStatsResponse | null;
  campaignReports: Record<string, CampaignReport>;
  campaignNames: Record<string, string>;
  range: "7d" | "30d" | "90d";
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCsv(props: Props): string {
  const rows: string[][] = [];
  rows.push(["section", "metric", "value"]);
  const r = props.stats as unknown as Record<string, unknown> | null;
  function pickNum(key: string): string {
    if (!r) return "";
    const v = r[key];
    return typeof v === "number" ? String(v) : "";
  }
  rows.push(["overview", "range", props.range]);
  rows.push(["overview", "subscribers_total", pickNum("subscribers_total")]);
  rows.push([
    "overview",
    "subscribers_added",
    pickNum("subscribers_added_30d"),
  ]);
  rows.push([
    "overview",
    "subscribers_unsubbed",
    pickNum("subscribers_unsubbed_30d"),
  ]);
  rows.push(["overview", "opens_total", pickNum("opens_total_30d")]);
  rows.push(["overview", "clicks_total", pickNum("clicks_total_30d")]);
  rows.push(["overview", "bounces_total", pickNum("bounces_total_30d")]);
  rows.push(["overview", "campaigns_sent", pickNum("campaigns_sent_30d")]);

  rows.push([]);
  rows.push([
    "campaign",
    "campaign_id",
    "name",
    "sent",
    "delivered",
    "unique_opens",
    "unique_clicks",
    "bounces",
    "complaints",
    "unsubscribes",
    "open_rate",
    "click_rate",
    "click_to_open_rate",
    "bounce_rate",
    "unsub_rate",
  ]);
  for (const [id, rep] of Object.entries(props.campaignReports)) {
    rows.push([
      "campaign",
      id,
      props.campaignNames[id] ?? "",
      String(rep.sent),
      String(rep.delivered),
      String(rep.unique_opens),
      String(rep.unique_clicks),
      String(rep.bounces),
      String(rep.complaints),
      String(rep.unsubscribes),
      String(rep.open_rate),
      String(rep.click_rate),
      String(rep.click_to_open_rate),
      String(rep.bounce_rate),
      String(rep.unsub_rate),
    ]);
  }

  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

export function ExportMenu(props: Props): ReactElement {
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
    menuRef,
    onClose: closeMenu,
    open,
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

  function doPrint(): void {
    closeMenu(true);
    // Defer so the menu closes before the print preview opens.
    setTimeout(() => window.print(), 50);
  }

  function doCsv(): void {
    closeMenu(true);
    const stamp = new Date().toISOString().slice(0, 10);
    void import("../../lib/file-transfer").then(({ saveFile }) =>
      saveFile({
        data: buildCsv(props),
        suggestedName: `postwave-analytics-${props.range}-${stamp}.csv`,
        label: "Analytics snapshot",
        privacy: "personal",
        mimeType: "text/csv;charset=utf-8",
      }).then((result) => {
        if (!result.ok) toast.error(result.message);
      }),
    );
  }

  return (
    <div className="analytics-popup-anchor">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="btn btn-sm"
        onClick={() => (open ? closeMenu(false) : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
      >
        Export ▾
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          className="analytics-popup analytics-popup--export"
          onBlurCapture={handleMenuBlur}
        >
          <MenuItem onClick={doCsv}>
            <strong>CSV snapshot</strong>
            <span className="analytics-menu-item-detail">
              Tenant-wide stats + recent campaigns
            </span>
          </MenuItem>
          <MenuItem onClick={doPrint}>
            <strong>Print / PDF</strong>
            <span className="analytics-menu-item-detail">
              Opens the system print dialog
            </span>
          </MenuItem>
        </div>
      ) : null}
      <style>{`
        @media print {
          aside, nav, .chips, .btn, .progress-bar { display: none !important; }
          .stat-card, .pw-chart-card { break-inside: avoid; page-break-inside: avoid; }
          body { background: white !important; color: black !important; }
        }
      `}</style>
    </div>
  );
}

function MenuItem({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className="analytics-menu-item"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
