/**
 * ChartActions — per-chart overflow menu.
 *
 * Today the only "share one chart" option on Analytics is a manual
 * screenshot or the global ExportMenu (whole-page CSV + print). When
 * an operator wants to drop a single chart into Slack — by far the
 * most common share workflow — that's 4-5 clicks of friction.
 *
 * This component lives in the top-right corner of every chart card
 * and offers two focused affordances:
 *   - Download PNG: SVG serialised to a 2x-DPR canvas + downloaded.
 *   - Copy link:   sets a `?focus=<chart-id>` hash so a returning
 *                  reader lands directly on (and scrolls to) the
 *                  same card via `Analytics.tsx`'s hash-pickup.
 *
 * We deliberately don't reach into the chart's internal SVG via a
 * forwarded ref — instead the parent passes us the wrapping `<div>`
 * via `getChartEl()` (returned at render time). That keeps the chart
 * components untouched and lets us export any SVG-based card (line,
 * multi-line, donut, funnel, heatmap) with the same exporter.
 *
 * CSV is intentionally owned by AccessibleChartData so its exact table,
 * provenance, injection hardening, and transfer metadata cannot diverge.
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
import { getDashboardUrl } from "../../lib/dashboard-url";
import { writeClipboardText } from "../../lib/clipboard";
import {
  type DesktopRoute,
  getDesktopRoute,
  serializeDesktopRoute,
} from "../../lib/desktop-router";
import { popDialog, pushDialog } from "../../lib/dialogStack";
import { toast } from "../Toast";

import "../../styles-analytics-popups.css";

export interface ChartActionsProps {
  /**
   * Stable kebab-case identifier for the chart. Used as the
   * `?focus=<id>` URL parameter and as part of the PNG filename.
   * Must match the `id` attribute on the chart card wrapper so
   * `scrollIntoView` can find it on reload.
   */
  chartId: string;
  /**
   * Human-readable chart name for menu accessibility labels and as
   * a fallback PNG filename prefix. E.g. "Engagement velocity".
   */
  chartName: string;
  /**
   * Current dashboard range label (e.g. "30d" or "2026-05-01 to
   * 2026-05-30"). Appended to the PNG filename so a researcher
   * who downloads two ranges back-to-back doesn't overwrite the
   * first file. Sanitised to filesystem-safe characters inline.
   */
  rangeLabel: string;
  /**
   * Returns the chart's wrapping element at click time. We resolve
   * lazily because the SVG may not exist yet when the parent renders
   * (skeleton state) and because resolving via a ref-callback inside
   * the chart components would require touching every chart file.
   */
  getChartEl: () => HTMLElement | null;
}

/* ---------- download helpers ---------------------------------------- */

/**
 * Sanitise a string for filename use: lowercase, dash-separated,
 * alphanumerics only. Avoids the OS-specific reserved characters
 * (`:`, `/`, `\`, `?`, `*`, etc.) without us having to enumerate them.
 */
function safeSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/* ---------- SVG → PNG ------------------------------------------------ */

/**
 * Serialise the chart's `<svg>` to a PNG via an offscreen canvas at
 * 2x device pixel ratio so the export still looks crisp at the
 * scaled-up viewing size users tend to drop screenshots into (Slack
 * lightboxes, retina monitors, exported PDFs).
 *
 * Pure SVG → PNG works in every modern browser via the Image() blob
 * trick — drawing an SVG document onto a canvas without tainting it,
 * provided every gradient/image embedded in the SVG is same-origin
 * (which all our charts are: they only paint solid theme-colour
 * fills + lines).
 *
 * CSS variables on the SVG (`var(--pw-accent)`) need to be resolved
 * before serialisation, because the freshly-built Image lives in its
 * own document with no CSS scope. We inline computed colours onto
 * the relevant nodes before serialising; without this the chart
 * would render with default browser fills (black) once detached.
 */
async function chartToPngBlob(svg: SVGSVGElement): Promise<Blob> {
  /* Width/height fall back to the bounding box if the attributes
   * aren't explicitly set — happens when the chart still uses 100%
   * widths under a flex parent and ResizeObserver hasn't fired. */
  const bbox = svg.getBoundingClientRect();
  const w = Math.max(1, Math.round(bbox.width));
  const h = Math.max(1, Math.round(bbox.height));

  /* Clone so we can mutate (inline computed styles) without
   * disturbing the live chart's hover/animation state. */
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  /* Resolve CSS variables on every node that uses theme colours.
   * We only need to inline the properties the charts actually use
   * (stroke, fill, color) — everything else is geometry. */
  const liveNodes = svg.querySelectorAll<SVGElement>("*");
  const cloneNodes = clone.querySelectorAll<SVGElement>("*");
  for (let i = 0; i < liveNodes.length; i++) {
    const live = liveNodes[i];
    const c = cloneNodes[i];
    if (!live || !c) continue;
    const cs = window.getComputedStyle(live);
    c.style.fill = cs.fill;
    c.style.stroke = cs.stroke;
    c.style.color = cs.color;
    c.style.opacity = cs.opacity;
    c.style.fillOpacity = cs.fillOpacity;
    c.style.strokeOpacity = cs.strokeOpacity;
    c.style.strokeWidth = cs.strokeWidth;
    c.style.strokeDasharray = cs.strokeDasharray;
    c.style.fontFamily = cs.fontFamily;
    c.style.fontSize = cs.fontSize;
  }

  /* Background — pull the live theme's elevated panel colour so the
   * PNG matches what you see on screen (dark theme shouldn't dump
   * a transparent SVG that renders white on Slack). */
  const bodyStyle = window.getComputedStyle(document.body);
  const bg =
    bodyStyle.getPropertyValue("--pw-bg-elev") ||
    bodyStyle.backgroundColor ||
    "#ffffff";

  const xml = new XMLSerializer().serializeToString(clone);
  /* Encode via base64 instead of percent-encoding: the latter
   * breaks on certain unicode (emoji) glyphs in chart titles. */
  const b64 = window.btoa(unescape(encodeURIComponent(xml)));
  const dataUrl = `data:image/svg+xml;base64,${b64}`;

  const dpr = Math.max(2, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.scale(dpr, dpr);
  /* Flat background → PNG isn't transparent on dark themes. */
  ctx.fillStyle = bg.trim();
  ctx.fillRect(0, 0, w, h);

  await new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, w, h);
      resolve();
    };
    img.onerror = () => reject(new Error("Failed to load SVG into Image"));
    img.src = dataUrl;
  });

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas toBlob returned null"));
    }, "image/png");
  });
}

/* ---------- copy-link --------------------------------------------- */

/**
 * Build the deep-link hash that scrolls Analytics to this chart on
 * reload. Preserves any other params already in the hash (range,
 * groupBy, cohort_*) so a teammate clicking the link lands on the
 * same view — not the page defaults. The `focus=` discriminator
 * is one-shot — once Analytics.tsx scrolls + flashes the card it
 * clears the param so refreshing doesn't keep re-scrolling.
 */
function buildFocusRoute(chartId: string): string {
  const current = getDesktopRoute();
  const base: DesktopRoute =
    current.section === "analytics" ? current : { section: "analytics" };
  const filters = (base.filters ?? []).filter(
    (filter) => filter.key !== "focus",
  );
  filters.push({ key: "focus", value: chartId });
  return serializeDesktopRoute({ ...base, filters });
}

/* ---------- component --------------------------------------------- */

export function ChartActions(props: ChartActionsProps): ReactElement {
  const { chartId, chartName, rangeLabel, getChartEl } = props;
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

  const safeRangeFragment = safeSlug(rangeLabel) || "range";
  const safeNameFragment = safeSlug(chartName) || chartId;

  async function doPng(): Promise<void> {
    closeMenu(true);
    const host = getChartEl();
    const svg = host?.querySelector("svg") as SVGSVGElement | null;
    if (!svg) {
      toast.info("Nothing to capture — chart is empty");
      return;
    }
    try {
      const blob = await chartToPngBlob(svg);
      const filename = `${safeNameFragment}-${safeRangeFragment}.png`;
      const { saveFile } = await import("../../lib/file-transfer");
      const saved = await saveFile({
        data: blob,
        suggestedName: filename,
        label: `${chartName} chart image`,
        privacy: "personal",
        mimeType: "image/png",
      });
      if (!saved.ok) throw new Error(saved.message);
    } catch {
      /* SVG-to-PNG can fail when an embedded image taints the
       * canvas (we don't embed any today but a future contributor
       * adding a logo would hit this). Surface a friendly error so
       * the user can fall back to a manual screenshot. */
      // eslint-disable-next-line no-console
      console.error("ChartActions PNG export failed");
      toast.error("PNG export failed — try a manual screenshot");
    }
  }

  async function doCopyLink(): Promise<void> {
    closeMenu(true);
    const route = buildFocusRoute(chartId);
    /* D17-prior-audit-recon#5: in the packaged Tauri app
     * `window.location.origin` is `tauri://localhost` — a scheme no
     * teammate (nor the sender's own OS) can open, so a pasted link did
     * nothing. Only trust the live origin when we're actually served from
     * a web page (http/https); otherwise build the link against the
     * configured web dashboard host so the pasted URL resolves for the
     * recipient. Use the full URL (not a lone `#fragment`) so it renders
     * as an actionable hyperlink in Slack / Notion / a doc. */
    const protocol =
      typeof window === "undefined" ? "" : window.location.protocol;
    const isWebOrigin = /^https?:$/i.test(protocol);
    let fullUrl: string;
    if (isWebOrigin) {
      fullUrl = `${window.location.origin}${route}`;
    } else {
      const base = getDashboardUrl().replace(/\/$/, "");
      fullUrl = `${base}${route}`;
    }
    const result = await writeClipboardText(fullUrl, {
      contentClass: "public",
      label: "Chart link",
    });
    if (result.ok) toast.success("Link copied");
    else toast.error(result.message);
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
        aria-label={`More actions for ${chartName}`}
        style={{
          /* Square footprint so the dots stay visually balanced —
           * the .btn-sm default padding optimises for word labels. */
          width: 28,
          height: 24,
          padding: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 1,
        }}
      >
        {/* Vertical three-dot glyph — same metaphor every modern app
         *  uses for overflow menus. We render with text instead of an
         *  SVG icon to inherit the .btn colour token automatically. */}
        <span aria-hidden style={{ fontSize: 16, letterSpacing: 1 }}>
          ⋯
        </span>
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={`${chartName} actions`}
          className="analytics-popup analytics-popup--chart-actions"
          onBlurCapture={handleMenuBlur}
        >
          <MenuItem
            onClick={() => {
              /* fire-and-forget: errors land in the inner try/catch */
              void doPng();
            }}
          >
            <strong>Download PNG</strong>
            <span className="analytics-menu-item-detail">
              2x-resolution screenshot
            </span>
          </MenuItem>
          <MenuItem
            onClick={() => {
              void doCopyLink();
            }}
          >
            <strong>Copy link</strong>
            <span className="analytics-menu-item-detail">
              Scrolls here on reload
            </span>
          </MenuItem>
        </div>
      ) : null}
    </div>
  );
}

/* Local copy of the small MenuItem renderer (the global ExportMenu
 * has the same one; keeping ours private avoids exporting a generic
 * MenuItem that would need its own API contract). */
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
