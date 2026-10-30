// SPDX-License-Identifier: MIT

const LOCAL_PREVIEW_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const BROWSER_AUTH_ORIGINS = new Set(["https://app.moosewave.com"]);
const BROWSER_AUTH_PATH = "/cli/auth";
const POSTWAVE_API_KEY_RE = /^pw_[A-Za-z0-9._-]{12,512}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function normalizeBrowserAuthUrl(
  raw: string | null | undefined,
): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  if (CONTROL_RE.test(trimmed)) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    if (!BROWSER_AUTH_ORIGINS.has(url.origin)) return null;
    if (url.pathname !== BROWSER_AUTH_PATH) return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeLocalPreviewBaseUrl(
  raw: string | null | undefined,
  fallback = "http://localhost:4321",
): string {
  const trimmed = (raw ?? fallback).trim();
  if (!trimmed || CONTROL_RE.test(trimmed)) return fallback;
  try {
    const url = new URL(trimmed);
    if (url.username || url.password) return fallback;
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    if (!LOCAL_PREVIEW_HOSTS.has(url.hostname.toLowerCase())) return fallback;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

export function buildLocalPreviewUrl(
  baseRaw: string | null | undefined,
  fileRel: string | null | undefined,
): string {
  const base = normalizeLocalPreviewBaseUrl(baseRaw);
  const safeFileRel = normalizePreviewFilePath(fileRel);
  if (!safeFileRel) return `${base}/preview`;
  return `${base}/preview/${encodeURIComponent(safeFileRel)}`;
}

export function normalizePreviewFilePath(
  raw: string | null | undefined,
): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || CONTROL_RE.test(trimmed) || trimmed.includes("\\")) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith("//")) {
    return null;
  }
  if (trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return null;
  }
  const parts = trimmed.split("/");
  if (parts.some((part) => isUnsafePathSegment(part))) return null;
  return trimmed;
}

/**
 * Whether a value is the loopback OAuth callback.
 *
 * The origin is checked, not assumed. `new URL(raw, base)` IGNORES the base
 * whenever `raw` is absolute or protocol-relative, so resolving against
 * "http://127.0.0.1" and then testing only `pathname` accepted
 * `https://evil.example/callback` and `//evil.example/callback` — a function
 * whose name is a loopback assertion, returning true for any host on the
 * internet.
 *
 * It has no production caller today; `cli-auth.ts` does its own check and does
 * it correctly (`url.origin !== "http://127.0.0.1"`). That is exactly why this
 * was worth repairing rather than leaving: it is exported, it is named as a
 * security predicate, and its five existing tests all passed because every one
 * of them fed it a path. The next person to reach for it would have had every
 * reason to believe it verified the origin.
 */
export function isLoopbackCallbackPath(
  raw: string | null | undefined,
): boolean {
  if (!raw || CONTROL_RE.test(raw)) return false;
  try {
    const url = new URL(raw, "http://127.0.0.1");
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (!LOCAL_PREVIEW_HOSTS.has(url.hostname.toLowerCase())) return false;
    if (url.username || url.password) return false;
    return url.pathname === "/callback";
  } catch {
    return false;
  }
}

export function buildLocalPreviewApiUrl(
  baseRaw: string | null | undefined,
  path: string,
): string {
  const base = normalizeLocalPreviewBaseUrl(baseRaw);
  const rawPath = String(path || "");
  if (
    rawPath.trim() !== rawPath ||
    CONTROL_RE.test(rawPath) ||
    rawPath.includes("\\")
  ) {
    throw new Error("Unsafe local preview API path");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath) || rawPath.startsWith("//")) {
    throw new Error("Unsafe local preview API path");
  }
  const relativePath = rawPath.replace(/^\/+/, "");
  const pathOnly = relativePath.split(/[?#]/, 1)[0] ?? "";
  if (pathOnly.split("/").some((segment) => isUnsafePathSegment(segment))) {
    throw new Error("Unsafe local preview API path");
  }
  return new URL(`./${relativePath}`, `${base}/`).toString();
}

function isUnsafePathSegment(segment: string): boolean {
  let current = segment;
  for (let i = 0; i < 2; i += 1) {
    const lower = current.toLowerCase();
    if (
      current === "." ||
      current === ".." ||
      lower === "%2e" ||
      lower === "%2e." ||
      lower === ".%2e" ||
      lower === "%2e%2e" ||
      CONTROL_RE.test(current) ||
      current.includes("\\")
    ) {
      return true;
    }
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return (
    current === "." ||
    current === ".." ||
    CONTROL_RE.test(current) ||
    current.includes("\\")
  );
}

export function isPostwaveApiKey(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  return trimmed === raw && POSTWAVE_API_KEY_RE.test(trimmed);
}

export function isSafeHeaderValue(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  return (
    Boolean(trimmed) &&
    trimmed === raw &&
    !/[\u0000-\u001f\u007f]/.test(trimmed)
  );
}

export function normalizePreviewWidth(
  raw: unknown,
  fallback: "mobile" | "desktop" = "desktop",
): "mobile" | "desktop" {
  return raw === "mobile" || raw === "desktop" ? raw : fallback;
}
