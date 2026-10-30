export type PlaygroundEnvironmentKind =
  | "local"
  | "non-production"
  | "production";

export interface PlaygroundEnvironment {
  host: string;
  kind: PlaygroundEnvironmentKind;
  label: string;
  tone: "neutral" | "warning" | "danger";
}

export type PlaygroundRequestRisk = "read" | "mutation" | "destructive";

const NON_PRODUCTION_HOST_PARTS = new Set([
  "dev",
  "development",
  "preview",
  "qa",
  "sandbox",
  "stage",
  "staging",
  "test",
]);

const HIGH_CONSEQUENCE_PATH_PARTS = new Set([
  "activate",
  "archive",
  "cancel",
  "delete",
  "disable",
  "disconnect",
  "execute",
  "migrate",
  "publish",
  "purge",
  "replay",
  "reset",
  "revoke",
  "rotate",
  "send",
  "suspend",
  "terminate",
]);

const SENSITIVE_HEADER_PARTS = [
  "authorization",
  "authenticate",
  "cookie",
  "credential",
  "csrf",
  "location",
  "nonce",
  "password",
  "secret",
  "session",
  "signature",
  "token",
  "x-api-key",
];

/**
 * Classify conservatively: an unknown or malformed remote URL is production.
 * A developer must opt into an unmistakable local/sandbox hostname before the
 * playground reduces its warning strength.
 */
export function classifyPlaygroundEnvironment(
  rawURL: string,
): PlaygroundEnvironment {
  try {
    const parsed = new URL(rawURL);
    const host = parsed.hostname.toLowerCase();
    const labels = host.split(/[.-]/).filter(Boolean);
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".localhost")
    ) {
      return { host, kind: "local", label: "Local", tone: "neutral" };
    }
    if (labels.some((label) => NON_PRODUCTION_HOST_PARTS.has(label))) {
      return {
        host,
        kind: "non-production",
        label: "Non-production",
        tone: "warning",
      };
    }
    return { host, kind: "production", label: "Production", tone: "danger" };
  } catch {
    return {
      host: "invalid API URL",
      kind: "production",
      label: "Production / unknown",
      tone: "danger",
    };
  }
}

export function classifyPlaygroundRequestRisk(
  method: string,
  path: string,
): PlaygroundRequestRisk {
  const normalizedMethod = method.toLowerCase();
  if (normalizedMethod === "get") return "read";
  if (normalizedMethod === "delete") return "destructive";
  const segments = path
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return segments.some((segment) => HIGH_CONSEQUENCE_PATH_PARTS.has(segment))
    ? "destructive"
    : "mutation";
}

export function playgroundConfirmationPhrase(
  method: string,
  path: string,
): string {
  return `${method.toUpperCase()} ${path}`;
}

export function isSensitivePlaygroundHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return SENSITIVE_HEADER_PARTS.some(
    (part) => normalized === part || normalized.includes(part),
  );
}

/**
 * Request bodies may contain subscriber data or credentials that a schema
 * cannot identify reliably. Keep history useful for timing/status/replay
 * routing without persisting the body, even inside encrypted history.
 */
export function historyBody(body: string): {
  body: "";
  bodyOmitted: boolean;
} {
  return body.trim()
    ? { body: "", bodyOmitted: true }
    : { body: "", bodyOmitted: false };
}
