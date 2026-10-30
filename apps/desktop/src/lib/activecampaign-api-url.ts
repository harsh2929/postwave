export function activeCampaignApiUrlError(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "Account API URL is required.";
  if (trimmed.includes("://") && !trimmed.startsWith("https://")) {
    return "Use an HTTPS ActiveCampaign API URL.";
  }

  const candidate = trimmed.startsWith("https://")
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return "Enter a valid ActiveCampaign API URL.";
  }
  if (url.protocol !== "https:") {
    return "Use an HTTPS ActiveCampaign API URL.";
  }
  if (url.username || url.password || url.search || url.hash) {
    return "Remove usernames, query strings, and fragments from the API URL.";
  }
  if (url.port && url.port !== "443") {
    return "ActiveCampaign API URLs must use the default HTTPS port (443).";
  }
  if (!isSafeActiveCampaignHost(url.hostname)) {
    return "Use the exact HTTPS hostname from ActiveCampaign Settings - Developer. IP, localhost, and single-label hosts are not accepted.";
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path && path !== "/api/3" && !path.startsWith("/api/3/")) {
    return "Use the ActiveCampaign account API root or an `/api/3` API URL.";
  }
  return null;
}

function isSafeActiveCampaignHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (
    !normalized ||
    normalized.length > 253 ||
    !normalized.includes(".") ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(normalized)
  ) {
    return false;
  }
  return normalized
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
