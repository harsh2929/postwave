/**
 * Turns the stable, machine-oriented audit action key into a short display
 * label. The raw key remains the forensic identifier and is rendered beside
 * this label in AuditRowDetail when the two differ.
 */

const ACRONYMS: Readonly<Record<string, string>> = {
  ai: "AI",
  api: "API",
  ccpa: "CCPA",
  csv: "CSV",
  dkim: "DKIM",
  dmarc: "DMARC",
  gdpr: "GDPR",
  http: "HTTP",
  https: "HTTPS",
  id: "ID",
  ip: "IP",
  mfa: "MFA",
  oauth: "OAuth",
  otp: "OTP",
  pii: "PII",
  saml: "SAML",
  sms: "SMS",
  spf: "SPF",
  sso: "SSO",
  totp: "TOTP",
  ui: "UI",
  uri: "URI",
  url: "URL",
  ux: "UX",
};

/** Base and already-inflected forms converge on one event label. */
const EVENT_VERBS: Readonly<Record<string, string>> = {
  acknowledge: "acknowledged",
  acknowledged: "acknowledged",
  activate: "activated",
  activated: "activated",
  add: "added",
  added: "added",
  approve: "approved",
  approved: "approved",
  archive: "archived",
  archived: "archived",
  assign: "assigned",
  assigned: "assigned",
  block: "blocked",
  blocked: "blocked",
  cancel: "cancelled",
  canceled: "cancelled",
  cancelled: "cancelled",
  change: "changed",
  changed: "changed",
  complete: "completed",
  completed: "completed",
  connect: "connected",
  connected: "connected",
  create: "created",
  created: "created",
  deactivate: "deactivated",
  deactivated: "deactivated",
  delete: "deleted",
  deleted: "deleted",
  disable: "disabled",
  disabled: "disabled",
  disconnect: "disconnected",
  disconnected: "disconnected",
  dismiss: "dismissed",
  dismissed: "dismissed",
  download: "downloaded",
  downloaded: "downloaded",
  edit: "edited",
  edited: "edited",
  enable: "enabled",
  enabled: "enabled",
  enroll: "enrolled",
  enrolled: "enrolled",
  export: "exported",
  exported: "exported",
  fail: "failed",
  failed: "failed",
  import: "imported",
  imported: "imported",
  invite: "invited",
  invited: "invited",
  link: "linked",
  linked: "linked",
  lock: "locked",
  locked: "locked",
  merge: "merged",
  merged: "merged",
  move: "moved",
  moved: "moved",
  override: "overridden",
  overridden: "overridden",
  pause: "paused",
  paused: "paused",
  publish: "published",
  published: "published",
  purge: "purged",
  purged: "purged",
  queue: "queued",
  queued: "queued",
  read: "viewed",
  recover: "recovered",
  recovered: "recovered",
  reject: "rejected",
  rejected: "rejected",
  remove: "removed",
  removed: "removed",
  reset: "reset",
  resolve: "resolved",
  resolved: "resolved",
  restore: "restored",
  restored: "restored",
  resume: "resumed",
  resumed: "resumed",
  retry: "retried",
  retried: "retried",
  revoke: "revoked",
  revoked: "revoked",
  rotate: "rotated",
  rotated: "rotated",
  schedule: "scheduled",
  scheduled: "scheduled",
  see: "marked as seen",
  seen: "marked as seen",
  send: "sent",
  sent: "sent",
  start: "started",
  started: "started",
  stop: "stopped",
  stopped: "stopped",
  succeed: "succeeded",
  succeeded: "succeeded",
  sync: "synced",
  synced: "synced",
  tag: "tagged",
  tagged: "tagged",
  trigger: "triggered",
  triggered: "triggered",
  unlink: "unlinked",
  unlinked: "unlinked",
  unlock: "unlocked",
  unlocked: "unlocked",
  unsubscribe: "unsubscribed",
  unsubscribed: "unsubscribed",
  update: "updated",
  updated: "updated",
  upload: "uploaded",
  uploaded: "uploaded",
  verify: "verified",
  verified: "verified",
  view: "viewed",
  viewed: "viewed",
};

const HTTP_EVENT_VERBS: Readonly<Record<string, string>> = {
  delete: "deleted",
  get: "viewed",
  head: "viewed",
  patch: "updated",
  post: "created",
  put: "updated",
};

function words(value: string): string[] {
  return value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^a-zA-Z\d]+/)
    .filter(Boolean);
}

function phrase(parts: readonly string[]): string {
  const formatted = parts.map((part) => {
    const lower = part.toLowerCase();
    return ACRONYMS[lower] ?? lower;
  });
  if (formatted.length === 0) return "Event";
  if (!ACRONYMS[formatted[0]!.toLowerCase()]) {
    formatted[0] =
      formatted[0]!.charAt(0).toUpperCase() + formatted[0]!.slice(1);
  }
  return formatted.join(" ");
}

function normalizeLastVerb(parts: string[]): string[] {
  if (parts.length === 0) return parts;
  const last = parts.length - 1;
  parts[last] = EVENT_VERBS[parts[last]!.toLowerCase()] ?? parts[last]!;
  return parts;
}

function authenticationLabel(parts: readonly string[]): string | null {
  const lower = parts.map((part) => part.toLowerCase());
  const login = lower.indexOf("login");
  if (login >= 0) {
    const outcome = lower.slice(login + 1);
    if (
      outcome.some(
        (part) => part === "fail" || part === "failed" || part === "failure",
      )
    ) {
      return "Sign-in failed";
    }
    if (outcome.some((part) => part === "block" || part === "blocked")) {
      return "Sign-in blocked";
    }
    if (
      outcome.some(
        (part) =>
          part === "succeed" || part === "succeeded" || part === "success",
      )
    ) {
      return "Sign-in succeeded";
    }
    return "Signed in";
  }

  const logout = lower.indexOf("logout");
  if (logout >= 0) {
    const outcome = lower.slice(logout + 1);
    if (
      outcome.some(
        (part) => part === "fail" || part === "failed" || part === "failure",
      )
    ) {
      return "Sign-out failed";
    }
    return "Signed out";
  }

  const mfa = lower.indexOf("mfa");
  if (mfa >= 0) {
    return phrase(normalizeLastVerb(["mfa", ...parts.slice(mfa + 1)]));
  }

  if (lower[0] === "auth" || lower[0] === "authentication") {
    const rest = normalizeLastVerb(parts.slice(1));
    return phrase(["authentication", ...rest]);
  }
  return null;
}

function httpLabel(value: string): string | null {
  const match = value.match(
    /^(?:(?:human|agent|system)[.\s:/_-]+)?http\.([^.]+)\.api\.v\d+\.(.+)$/i,
  );
  if (!match) return null;

  const method = match[1]!.toLowerCase();
  const path = match[2]!.split(".").filter(Boolean);
  if (path.length === 0) return "Event";

  const finalWords = words(path[path.length - 1]!);
  const finalWord = finalWords[finalWords.length - 1]?.toLowerCase();
  const hasExplicitAction =
    path.length > 1 && Boolean(finalWord && EVENT_VERBS[finalWord]);

  if (hasExplicitAction) {
    const resource = path.slice(0, -1).flatMap(words);
    return phrase(normalizeLastVerb([...resource, ...finalWords]));
  }

  const resource = path.flatMap(words);
  return phrase([...resource, HTTP_EVENT_VERBS[method] ?? "changed"]);
}

/**
 * Convert an audit action key into sentence-cased display text. This function
 * is deliberately total: malformed or future keys remain readable and never
 * make an audit row disappear.
 */
export function auditActionLabel(action: unknown): string {
  if (typeof action !== "string") return "Event";
  const value = action.trim();
  if (!value) return "Event";

  const fromHttp = httpLabel(value);
  if (fromHttp) return fromHttp;

  const parts = words(value);
  if (parts.length === 0) return "Event";

  const fromAuthentication = authenticationLabel(parts);
  if (fromAuthentication) return fromAuthentication;

  return phrase(normalizeLastVerb(parts));
}
