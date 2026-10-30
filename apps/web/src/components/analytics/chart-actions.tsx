// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Per-chart overflow menu on the Analytics page (desktop ChartActions). Its
// verb is "Copy link": an absolute /app/analytics URL carrying the current
// view (range, tab, metric, compare…) plus `focus=<chartId>`, so whoever opens
// it lands on the same window with that chart scrolled into view and
// highlighted. The clipboard outcome is always reported — a rejected write is
// never silent.
//
// "Download PNG" (desktop ChartActions doPng) is offered when the caller hands
// over the chart's wrapping element: its <svg> is cloned with the computed
// theme colours inlined (a detached SVG has no stylesheet, so var(--chart-*)
// would paint black), drawn onto a 2x canvas over the card's background, and
// saved through lib/download. Every outcome is reported, never silent.

import { ImageDown, Link2 } from "lucide-react";
import { toast } from "sonner";

import { ActionMenu, type ActionMenuItem } from "@/components/ui/action-menu";
import { buildAnalyticsChartLink } from "@/lib/analytics-view-params";
import { copyToClipboard } from "@/lib/clipboard";
import { downloadBlobFile } from "@/lib/download";

/** Lowercase, dash-separated, filesystem-safe. */
function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** e.g. "engagement-breakdown-30d.png" — the range keeps two downloads apart. */
export function chartImageFilename(
  chartName: string,
  chartId: string,
  rangeLabel?: string | null,
): string {
  const name = safeSlug(chartName) || safeSlug(chartId) || "chart";
  const range = rangeLabel ? safeSlug(rangeLabel) : "";
  return range ? `${name}-${range}.png` : `${name}.png`;
}

const INLINED_STYLES = [
  "fill",
  "stroke",
  "color",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "stroke-width",
  "stroke-dasharray",
  "font-family",
  "font-size",
] as const;

/** Base64 of a UTF-8 string, without the deprecated unescape() trick. */
function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return window.btoa(binary);
}

/** The first non-transparent background at or above `el`, else white. */
function backgroundBehind(el: Element): string {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const bg = window.getComputedStyle(node).backgroundColor;
    if (bg && bg !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return "#ffffff";
}

/** Serialize the chart's SVG (theme colours resolved) as a data: URL. */
export function chartSvgDataUrl(
  svg: SVGSVGElement,
  width: number,
  height: number,
): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  const live = [svg, ...Array.from(svg.querySelectorAll<SVGElement>("*"))];
  const copies = [
    clone,
    ...Array.from(clone.querySelectorAll<SVGElement>("*")),
  ];
  live.forEach((node, index) => {
    const copy = copies[index];
    if (!copy) return;
    const computed = window.getComputedStyle(node);
    for (const property of INLINED_STYLES) {
      const value = computed.getPropertyValue(property);
      if (value) copy.style.setProperty(property, value);
    }
  });
  const xml = new XMLSerializer().serializeToString(clone);
  return `data:image/svg+xml;base64,${utf8Base64(xml)}`;
}

/** Rasterize a chart SVG to a PNG at (at least) 2x device pixel ratio. */
export async function chartSvgToPngBlob(svg: SVGSVGElement): Promise<Blob> {
  const box = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(box.width));
  const height = Math.max(1, Math.round(box.height));
  const dataUrl = chartSvgDataUrl(svg, width, height);

  const dpr = Math.max(2, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.scale(dpr, dpr);
  // A flat background so a dark-theme chart isn't a transparent PNG.
  ctx.fillStyle = backgroundBehind(svg);
  ctx.fillRect(0, 0, width, height);

  await new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, width, height);
      resolve();
    };
    img.onerror = () => reject(new Error("The chart SVG could not be loaded"));
    img.src = dataUrl;
  });

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas produced no image"));
    }, "image/png");
  });
}

/**
 * The chart's own <svg> inside a card: the app's charts are role="img"; a
 * card also holds lucide icon SVGs (the menu trigger itself), never those.
 */
export function findChartSvg(host: HTMLElement | null): SVGSVGElement | null {
  if (!host) return null;
  const labelled = host.querySelector<SVGSVGElement>('svg[role="img"]');
  if (labelled) return labelled;
  return (
    Array.from(host.querySelectorAll<SVGSVGElement>("svg")).find(
      (svg) =>
        !svg.classList.contains("lucide") &&
        svg.getAttribute("aria-hidden") !== "true",
    ) ?? null
  );
}

/** Capture the chart inside `host` and download it; reports the outcome. */
export async function downloadChartPng(
  host: HTMLElement | null,
  filename: string,
): Promise<"downloaded" | "empty" | "failed"> {
  const svg = findChartSvg(host);
  if (!svg) {
    toast.info("There's no chart to capture yet.");
    return "empty";
  }
  try {
    const blob = await chartSvgToPngBlob(svg);
    downloadBlobFile(filename, blob);
    toast.success("Chart image downloaded.");
    return "downloaded";
  } catch {
    toast.error(
      "The chart image couldn't be created. Take a screenshot instead.",
    );
    return "failed";
  }
}

export async function copyAnalyticsChartLink(
  chartId: string,
  extra: Record<string, string | null | undefined> = {},
): Promise<void> {
  const link = buildAnalyticsChartLink(
    window.location.origin,
    window.location.search,
    chartId,
    extra,
  );
  const outcome = await copyToClipboard(link);
  if (outcome === "copied") {
    toast.success("Chart link copied.");
  } else if (outcome === "unavailable") {
    toast.error(
      "This browser doesn't allow copying here. Copy the link from the address bar instead.",
    );
  } else {
    toast.error("The link couldn't be copied to your clipboard.");
  }
}

export function ChartActions({
  chartId,
  chartName,
  extra,
  getChartElement,
  rangeLabel,
}: {
  /** Stable id the page matches against ?focus=. */
  chartId: string;
  /** Human name, used in the trigger's accessible label. */
  chartName: string;
  /** Chart-specific view params to carry in the link (null drops one). */
  extra?: Record<string, string | null | undefined>;
  /**
   * The element wrapping the chart's <svg>, resolved at click time. When
   * given, the menu offers "Download PNG".
   */
  getChartElement?: () => HTMLElement | null;
  /** Window label for the PNG filename, e.g. "30d". */
  rangeLabel?: string | null;
}) {
  const items: ActionMenuItem[] = [];
  if (getChartElement) {
    items.push({
      label: "Download PNG",
      icon: <ImageDown className="h-4 w-4" aria-hidden />,
      onSelect: () => {
        void downloadChartPng(
          getChartElement(),
          chartImageFilename(chartName, chartId, rangeLabel),
        );
      },
    });
  }
  items.push({
    label: "Copy link",
    icon: <Link2 className="h-4 w-4" aria-hidden />,
    onSelect: () => {
      void copyAnalyticsChartLink(chartId, extra);
    },
  });
  return <ActionMenu label={`More actions for ${chartName}`} items={items} />;
}
