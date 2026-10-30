// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";

import {
  campaignTemplateCapabilities,
  getCampaignTemplate,
  type CampaignTemplateSummary,
} from "@/lib/campaign-templates-api";
import { compileMjmlSource } from "@/components/editor/compile-mjml";
import { cn } from "@/lib/utils";

import { PreviewImage } from "./preview-image";
import { DESKTOP_PREVIEW_WIDTH, previewDocument } from "./template-preview";

/**
 * Width the card frame is drawn at before it is scaled down to the card: the
 * detail page's desktop preview width. Drawing at the 600px the designs are
 * authored at would trip their phone stylesheet (max-width:620px) and show
 * stacked columns on a desktop card.
 */
const DESIGN_WIDTH = DESKTOP_PREVIEW_WIDTH;

// One source request per template version for the whole session: cards
// re-render on every filter change, and the same design appears in several
// tabs. A failed request is dropped so a later mount can try again.
const sourceRequests = new Map<string, Promise<string | null>>();

function sourceCacheKey(template: CampaignTemplateSummary): string {
  return `${template.id}:${template.etag ?? template.version ?? ""}`;
}

function loadTemplateSource(id: string, key: string): Promise<string | null> {
  let request = sourceRequests.get(key);
  if (!request) {
    request = getCampaignTemplate(id).then(async (full) => {
      const html = full.body_html?.trim();
      if (html) return html;
      const source = full.body_mjml?.trim();
      if (!source) return null;
      const compiled = await compileMjmlSource(source);
      return compiled.html.trim() || null;
    });
    request.catch(() => sourceRequests.delete(key));
    sourceRequests.set(key, request);
  }
  return request;
}

/** Test seam: forget every cached source request. */
export function resetTemplateSourceThumbnailCache(): void {
  sourceRequests.clear();
}

/**
 * True when a card has no hosted preview image but its editable HTML or MJML
 * source can be drawn instead. MJML-only library designs use the same compiler
 * as the editor, so their cards still have a useful visual preview.
 */
export function canDrawTemplateSource(
  template: CampaignTemplateSummary,
): boolean {
  return (
    template.template_kind === "editable" &&
    (campaignTemplateCapabilities(template).has_source_html ||
      campaignTemplateCapabilities(template).has_source_mjml)
  );
}

type SourceState =
  | { status: "idle" | "loading" }
  | { status: "ready"; html: string }
  | { status: "failed" };

/**
 * A card thumbnail drawn from the template's editable source: fetched only once
 * the card nears the viewport, rendered at design width in a sandboxed,
 * network-silent frame (the same document the detail preview uses), and
 * scaled to the card. The frame is decorative — the wrapper carries the
 * image name, and the frame never takes focus or pointer input, so the card
 * behaves exactly as it does with an image. Any failure falls back to the
 * shared "Preview unavailable" block.
 */
export function TemplateSourceThumbnail({
  template,
  alt,
  wrapperClassName,
}: {
  template: CampaignTemplateSummary;
  alt: string;
  wrapperClassName?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState<SourceState>({ status: "idle" });
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );

  useEffect(() => {
    const node = containerRef.current;
    if (!node || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height });
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Keyed by id and version, never by object identity: every search refresh
  // hands the card a new object for the same design.
  const templateId = template.id;
  const cacheKey = sourceCacheKey(template);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setSource({ status: "loading" });
    loadTemplateSource(templateId, cacheKey).then(
      (html) => {
        if (cancelled) return;
        setSource(html ? { status: "ready", html } : { status: "failed" });
      },
      () => {
        if (!cancelled) setSource({ status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [visible, templateId, cacheKey]);

  if (source.status === "failed") {
    return <PreviewImage alt={alt} wrapperClassName={wrapperClassName} />;
  }

  // Before the card has been measured, draw at a typical card width; the
  // ResizeObserver corrects it on the next frame.
  const scale = (size?.width ?? 280) / DESIGN_WIDTH;
  const frameHeight = Math.ceil((size?.height ?? 350) / scale);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={alt}
      aria-busy={source.status !== "ready"}
      data-slot="template-source-thumbnail"
      className={cn("overflow-hidden bg-white", wrapperClassName)}
    >
      {source.status === "ready" ? (
        <iframe
          title={alt}
          srcDoc={previewDocument(source.html, false)}
          sandbox=""
          referrerPolicy="no-referrer"
          tabIndex={-1}
          aria-hidden="true"
          scrolling="no"
          className="pointer-events-none origin-top-left border-0"
          style={{
            width: DESIGN_WIDTH,
            height: frameHeight,
            transform: `scale(${scale})`,
          }}
        />
      ) : (
        <div
          className="h-full w-full animate-pulse bg-muted/40 motion-reduce:animate-none"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
