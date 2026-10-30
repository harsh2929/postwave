// SPDX-License-Identifier: AGPL-3.0-only

export interface OpsRuntimeConfig {
  apiOrigin: string;
  publicOrigin: string;
  runbookBaseURL: string;
  production: boolean;
}

export class OpsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsConfigError";
  }
}

export function loadOpsRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpsRuntimeConfig {
  const production = env.NODE_ENV === "production";
  const apiOrigin = parseOrigin(
    "OPS_API_ORIGIN",
    env.OPS_API_ORIGIN,
    production,
    "http://127.0.0.1:8080",
  );
  const publicOrigin = parseOrigin(
    "OPS_PUBLIC_ORIGIN",
    env.OPS_PUBLIC_ORIGIN,
    production,
    "http://127.0.0.1:3100",
  );

  const allowlistedHosts = new Set(
    (env.OPS_API_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (production && allowlistedHosts.size === 0) {
    throw new OpsConfigError(
      "OPS_API_ALLOWED_HOSTS is required in production and must contain exact hosts",
    );
  }
  const apiHost = new URL(apiOrigin).host.toLowerCase();
  if (production && !allowlistedHosts.has(apiHost)) {
    throw new OpsConfigError(
      "OPS_API_ORIGIN host is not present in OPS_API_ALLOWED_HOSTS",
    );
  }

  const rawRunbookBase = env.OPS_RUNBOOK_BASE_URL?.trim();
  if (production && !rawRunbookBase) {
    throw new OpsConfigError("OPS_RUNBOOK_BASE_URL is required in production");
  }
  const runbookBaseURL = parseRunbookBase(
    rawRunbookBase ?? `${publicOrigin}/docs/runbooks/`,
    production,
  );

  return { apiOrigin, publicOrigin, runbookBaseURL, production };
}

function parseOrigin(
  name: string,
  raw: string | undefined,
  production: boolean,
  developmentDefault: string,
): string {
  const value = raw?.trim() || (production ? "" : developmentDefault);
  if (!value) throw new OpsConfigError(`${name} is required in production`);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpsConfigError(`${name} must be an absolute URL`);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new OpsConfigError(`${name} must be an origin without credentials or a path`);
  }
  if (production && url.protocol !== "https:") {
    throw new OpsConfigError(`${name} must use HTTPS in production`);
  }
  if (!production && url.protocol !== "https:" && !isLoopbackHTTP(url)) {
    throw new OpsConfigError(`${name} may use HTTP only on loopback in development`);
  }
  return url.origin;
}

function parseRunbookBase(raw: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OpsConfigError("OPS_RUNBOOK_BASE_URL must be an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new OpsConfigError(
      "OPS_RUNBOOK_BASE_URL must not contain credentials, a query, or a fragment",
    );
  }
  if (production && url.protocol !== "https:") {
    throw new OpsConfigError("OPS_RUNBOOK_BASE_URL must use HTTPS in production");
  }
  if (!production && url.protocol !== "https:" && !isLoopbackHTTP(url)) {
    throw new OpsConfigError(
      "OPS_RUNBOOK_BASE_URL may use HTTP only on loopback in development",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function isLoopbackHTTP(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost")
  );
}
