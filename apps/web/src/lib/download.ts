// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Trigger a browser download of in-memory data. Centralizes the Blob +
// object-URL + revoke dance that was hand-rolled across several surfaces.

export function downloadBlobFile(filename: string, blob: Blob): void {
  if (typeof window === "undefined") return;
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick so the click has committed the navigation.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = "text/plain;charset=utf-8",
): void {
  downloadBlobFile(filename, new Blob([content], { type: mimeType }));
}
