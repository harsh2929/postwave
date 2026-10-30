// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Downloadable QR code for the hosted form URL (FORM-036). The QR is always
// rendered dark-on-white (scanners need the contrast, independent of app
// theme). Encoding is delegated to the tested `qrSvg` helper; downloads are
// offered as SVG (vector, print-ready) and PNG (rendered via an offscreen
// canvas in the browser).

import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { downloadTextFile } from "@/lib/download";
import { qrPath, qrSvg } from "@/lib/qr-code";

interface FormQrCardProps {
  url: string;
  filenameBase: string;
}

export function FormQrCard({ url, filenameBase }: FormQrCardProps) {
  const matrix = useMemo(() => qrPath(url, { margin: 2 }), [url]);
  const svg = useMemo(() => qrSvg(url, { margin: 2 }), [url]);
  const [busy, setBusy] = useState(false);

  function downloadSvg() {
    downloadTextFile(
      `${filenameBase}-qr.svg`,
      svg,
      "image/svg+xml;charset=utf-8",
    );
  }

  async function downloadPng() {
    if (typeof window === "undefined") return;
    setBusy(true);
    try {
      const size = 512;
      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      const objUrl = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.width = size;
        img.height = size;
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("QR render failed"));
          img.src = objUrl;
        });
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas unavailable");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        const pngUrl = canvas.toDataURL("image/png");
        const a = document.createElement("a");
        a.href = pngUrl;
        a.download = `${filenameBase}-qr.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        URL.revokeObjectURL(objUrl);
      }
    } catch {
      toast.error("Could not render the PNG. Download the SVG instead.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-slot="form-qr-card"
      className="min-w-0 rounded-md border bg-card p-4"
    >
      <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide mb-3">
        QR code
      </h3>
      <div
        data-slot="form-qr-layout"
        className="flex min-w-0 flex-col items-stretch gap-4 sm:flex-row sm:items-center"
      >
        <svg
          viewBox={`0 0 ${matrix.dim} ${matrix.dim}`}
          className="h-32 w-32 shrink-0 self-center rounded-md border bg-white p-2 sm:self-auto"
          shapeRendering="crispEdges"
          role="img"
          aria-label="QR code for the hosted form URL"
        >
          <rect width={matrix.dim} height={matrix.dim} fill="#ffffff" />
          <path d={matrix.path} fill="#0f172a" />
        </svg>
        <div className="min-w-0 space-y-2">
          <p className="text-xs text-muted-foreground">
            Print it on flyers or show it at events — scanning opens the hosted
            form.
          </p>
          <div
            data-slot="form-qr-actions"
            className="flex min-w-0 flex-wrap gap-2"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={downloadSvg}
            >
              <Download className="h-3.5 w-3.5" />
              SVG
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={() => void downloadPng()}
              disabled={busy}
            >
              <Download className="h-3.5 w-3.5" />
              {busy ? "Rendering…" : "PNG"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
