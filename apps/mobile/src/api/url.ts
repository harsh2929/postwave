import { BUILD_PROFILE } from "@/lib/config";
import { httpHostAllowed } from "@/lib/httpHostPolicy";

export function normalizeApiBaseUrl(raw: string): string {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  try {
    const url = new URL(value);
    if (url.protocol === "http:") {
      // Shared with the sign-in form's validator (lib/config.ts) rather than
      // restated here. This file used to carry its own loopback-only copy, and
      // when the policy was relaxed for on-device development this copy was
      // missed — so the form accepted a LAN address that this function then
      // threw on, synchronously, from inside createAuthClient.
      if (!httpHostAllowed(url.hostname, BUILD_PROFILE)) {
        throw new Error("http requires localhost");
      }
    } else if (url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("unsafe URL components");
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error(
      "API base URL must be a valid http(s) URL without credentials, query, or fragment",
    );
  }
}

export function apiUrl(baseUrl: string, path: string): string {
  const base = new URL(`${normalizeApiBaseUrl(baseUrl)}/`);
  const rawPath = String(path || "");
  if (rawPath.trim() !== rawPath || /[\r\n]/.test(rawPath)) {
    throw new Error("Unsafe API path");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath) || rawPath.startsWith("//")) {
    throw new Error("Unsafe API path");
  }
  const relativePath = rawPath.replace(/^\/+/, "");
  const pathOnly = relativePath.split(/[?#]/, 1)[0] ?? "";
  if (
    pathOnly.split("/").some((segment) => {
      const lower = segment.toLowerCase();
      return (
        segment === "." ||
        segment === ".." ||
        lower === "%2e" ||
        lower === "%2e." ||
        lower === ".%2e" ||
        lower === "%2e%2e"
      );
    })
  ) {
    throw new Error("Unsafe API path");
  }
  const url = new URL(`${base.toString()}${relativePath}`);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw new Error("Unsafe API path");
  }
  return url.toString();
}
