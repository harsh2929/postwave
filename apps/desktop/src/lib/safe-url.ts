export function safeExternalAssetUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.protocol === "http:" && !isLocalHost(url.hostname)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function safeFormSuccessRedirectUrl(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    // Reject backslashes: browsers normalize `\` → `/`, so `/\evil.com`
    // would resolve as the protocol-relative `//evil.com` (open redirect).
    // Mirrors safeDashboardPath in dashboard-url.ts.
    if (trimmed.includes("\\")) return null;
    return /[\r\n\x00]/.test(trimmed) ? null : trimmed;
  }
  try {
    const url = new URL(trimmed);
    if (url.username || url.password) return null;
    if (url.protocol === "https:" || isLocalHttpUrl(url)) {
      url.hash = "";
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

function isLocalHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && isLocalHost(url.hostname);
}
