// SPDX-License-Identifier: AGPL-3.0-only

export function publicOrigin(
  raw: string | null | undefined,
  fallback: string,
): string {
  const input = (raw ?? fallback).trim();
  if (!input || /[\u0000-\u001f\u007f]/.test(input)) return fallback;
  try {
    const url = new URL(input.replace(/\/+$/, ""));
    if (url.protocol === "http:") {
      if (!isLocalOriginHost(url.hostname)) return fallback;
    } else if (url.protocol !== "https:") return fallback;
    if (url.username || url.password) return fallback;
    if (url.search || url.hash) return fallback;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

function isLocalOriginHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function publicSiteOrigin(): string {
  return publicOrigin(process.env.NEXT_PUBLIC_SITE_URL, "https://moosewave.com");
}

export function publicDocsOrigin(): string {
  return publicOrigin(process.env.NEXT_PUBLIC_DOCS_URL, "https://docs.moosewave.com");
}
