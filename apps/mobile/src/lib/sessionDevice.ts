/**
 * sessionDevice — turn a raw `SessionInfo` row into something a human can
 * recognise on a phone screen.
 *
 * `GET /api/v1/auth/sessions` (apps/api/internal/auth/sessions_handler.go)
 * returns id / issued_at / last_seen_at / expires_at / ip / user_agent /
 * auth_method / current. There is no device label and no geo enrichment, so
 * every client that renders the list has to derive a label from the
 * user-agent. Doing that inline in a component means it cannot be tested and
 * it drifts; it lives here instead.
 *
 * The parsing is deliberately shallow. A user-agent is attacker-influenced
 * text: it is matched against a fixed vocabulary of known tokens and NEVER
 * echoed verbatim, so a hostile UA cannot inject arbitrary prose (or a
 * screenful of text) into the security screen.
 */

const BROWSERS: readonly { token: RegExp; label: string }[] = [
  { token: /\bEdg(?:e|A|iOS)?\//i, label: "Edge" },
  { token: /\bOPR\/|\bOpera\b/i, label: "Opera" },
  { token: /\bFirefox\/|\bFxiOS\//i, label: "Firefox" },
  { token: /\bChrome\/|\bCriOS\//i, label: "Chrome" },
  { token: /\bSafari\//i, label: "Safari" },
];

const PLATFORMS: readonly { token: RegExp; label: string }[] = [
  { token: /\biPhone\b/i, label: "iPhone" },
  { token: /\biPad\b/i, label: "iPad" },
  { token: /\bAndroid\b/i, label: "Android" },
  { token: /\bWindows\b/i, label: "Windows" },
  { token: /\bMac OS X\b|\bMacintosh\b/i, label: "macOS" },
  { token: /\bCrOS\b/i, label: "ChromeOS" },
  { token: /\bLinux\b/i, label: "Linux" },
];

/** Non-browser clients we issue sessions to, matched before the browser list. */
const CLIENTS: readonly { token: RegExp; label: string }[] = [
  {
    token: /postwave-mobile|Moosewave\/.*(iOS|Android)/i,
    label: "Moosewave app",
  },
  { token: /postwave-cli|\bpostwave\/\d/i, label: "Moosewave CLI" },
  { token: /\bcurl\/|\bwget\//i, label: "Command line" },
];

/**
 * A short, recognisable label. Returns "Unknown device" rather than an empty
 * string so a row is never blank — an unlabelled row is exactly the one a user
 * cannot decide about.
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").slice(0, 512);
  if (!ua.trim()) return "Unknown device";
  for (const client of CLIENTS) {
    if (client.token.test(ua)) return client.label;
  }
  const browser = BROWSERS.find((entry) => entry.token.test(ua))?.label;
  const platform = PLATFORMS.find((entry) => entry.token.test(ua))?.label;
  if (browser && platform) return `${browser} · ${platform}`;
  return browser ?? platform ?? "Unknown device";
}

const AUTH_METHOD_COPY: Record<string, string> = {
  password: "Password",
  magic_link: "Magic link",
  magic: "Magic link",
  oauth: "Google",
  oauth_google: "Google",
  google: "Google",
  api_key: "API key",
  cli: "CLI",
  session: "Password",
  device_grant: "Approved from another device",
  workspace_switch: "Workspace switch",
  webauthn: "Passkey",
};

export function authMethodLabel(method: string | null | undefined): string {
  const value = (method ?? "").trim().toLowerCase();
  if (!value) return "Unknown method";
  return AUTH_METHOD_COPY[value] ?? "Unknown method";
}

/**
 * IPs are shown truncated. Nobody recognises their own IP, and the full
 * address is PII we do not need on a glanceable list; the leading octets are
 * enough to tell "same network as me" from "somewhere else".
 */
export function shortIp(ip: string | null | undefined): string | null {
  const value = (ip ?? "").trim();
  if (!value || value.length > 64) return null;
  if (value.includes(":")) {
    const groups = value.split(":").filter(Boolean);
    return groups.length >= 2 ? `${groups[0]}:${groups[1]}::…` : null;
  }
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  return `${parts[0]}.${parts[1]}.×.×`;
}

export interface SessionRowSummary {
  title: string;
  /** Secondary line: method, truncated IP — only the parts we actually have. */
  detail: string;
  /** True when this row is the phone the user is holding. */
  current: boolean;
}

export function sessionRowSummary(session: {
  userAgent?: string | null;
  authMethod?: string | null;
  ip?: string | null;
  current?: boolean;
}): SessionRowSummary {
  const parts = [authMethodLabel(session.authMethod)];
  const ip = shortIp(session.ip);
  if (ip) parts.push(ip);
  return {
    title: deviceLabel(session.userAgent),
    detail: parts.join(" · "),
    current: Boolean(session.current),
  };
}

/**
 * A row this module can order. The wire field is `last_seen_at` (the shape
 * `GET /api/v1/auth/sessions` actually returns); the camelCase alias is
 * accepted so a caller holding an already-mapped row is not silently sorted
 * into arbitrary order. Reading only one of the two is exactly the drift that
 * makes a security list look sorted while it is not — every field here is
 * optional, so TypeScript cannot catch a caller that supplies neither.
 */
export interface SessionOrderable {
  current?: boolean;
  last_seen_at?: string | null;
  lastSeenAt?: string | null;
}

function lastSeenMs(row: SessionOrderable): number {
  return Date.parse(row.last_seen_at ?? row.lastSeenAt ?? "");
}

/**
 * Sort order for the list: the current device first (it is the one row the
 * user must NOT revoke by accident), then most recently seen.
 */
export function compareSessions(
  a: SessionOrderable,
  b: SessionOrderable,
): number {
  if (Boolean(a.current) !== Boolean(b.current)) return a.current ? -1 : 1;
  const at = lastSeenMs(a);
  const bt = lastSeenMs(b);
  if (Number.isFinite(at) && Number.isFinite(bt)) return bt - at;
  if (Number.isFinite(at)) return -1;
  if (Number.isFinite(bt)) return 1;
  return 0;
}
