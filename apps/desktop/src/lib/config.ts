interface DesktopEnv {
  readonly DEV?: boolean;
  readonly VITE_API_URL?: string;
  readonly VITE_POSTWAVE_ASSETS_BASE_URL?: string;
  readonly VITE_REFERENCE_PREVIEW_ORIGIN?: string;
  readonly VITE_BUILD_PROFILE?: string;
  readonly VITE_PRIVACY_POLICY_URL?: string;
  readonly VITE_TERMS_URL?: string;
  readonly VITE_SUPPORT_URL?: string;
  readonly VITE_ACCOUNT_DELETION_URL?: string;
  readonly VITE_ENABLE_CAMPAIGN_CONTENT_AST_V2?: string;
}

function readEnv(): DesktopEnv {
  return ((import.meta as unknown as { env?: DesktopEnv }).env ??
    {}) as DesktopEnv;
}

const env = readEnv();

/** Build-time rollout gate for mutation of the lossless semantic-email tree. */
export const CAMPAIGN_CONTENT_AST_V2_ENABLED =
  env.VITE_ENABLE_CAMPAIGN_CONTENT_AST_V2 === "1";

/**
 * Explicit local-demo build switch. Demo fixtures are read-only fallbacks for
 * empty GET surfaces; production and ordinary development builds never use
 * them. Keeping this tied to a build profile makes the prospective-client
 * package deterministic without teaching a production binary to invent data.
 */
export const DEMO_DATA_FALLBACK_ENABLED =
  (env.VITE_BUILD_PROFILE ?? "").trim().toLowerCase() === "demo";

export const DEFAULT_API_URL = normalizeApiUrl(
  env.VITE_API_URL ||
    (isProductionBuild()
      ? "https://api.moosewave.com"
      : "http://localhost:8080"),
);

/**
 * Exact public base used for server-sanitized, Moosewave-hosted assets.
 * Campaign-template previews fail closed when this is absent or invalid;
 * provider/source URLs are never treated as trusted preview content.
 */
export const POSTWAVE_ASSETS_BASE_URL = normalizeOptionalAssetBaseUrl(
  env.VITE_POSTWAVE_ASSETS_BASE_URL,
);

/**
 * Optional development/demo-only origin for source-owned reference previews.
 * Production builds always ignore it; normal deployments continue to require
 * sanitized Moosewave-hosted preview assets.
 */
export const REFERENCE_TEMPLATE_PREVIEW_ORIGIN = isProductionBuild()
  ? null
  : normalizeOptionalHttpsOrigin(env.VITE_REFERENCE_PREVIEW_ORIGIN);

export const LEGAL_URLS = {
  privacy: normalizePublicHttpsUrl(
    env.VITE_PRIVACY_POLICY_URL,
    "https://moosewave.com/legal/privacy",
  ),
  terms: normalizePublicHttpsUrl(
    env.VITE_TERMS_URL,
    "https://moosewave.com/legal/terms",
  ),
  support: normalizePublicHttpsUrl(
    env.VITE_SUPPORT_URL,
    "https://docs.moosewave.com",
  ),
  accountDeletion: normalizePublicHttpsUrl(
    env.VITE_ACCOUNT_DELETION_URL ||
      "https://moosewave.com/legal/account-deletion",
    "https://moosewave.com/legal/account-deletion",
  ),
} as const;

export type LegalUrlKey = keyof typeof LEGAL_URLS;

export type ApiUrlValidation =
  | { ok: true; url: string }
  | { ok: false; message: string };

export function normalizeApiUrl(url: string | null | undefined): string {
  const v = (url ?? "").trim();
  return v ? v.replace(/\/+$/, "") : DEFAULT_API_URL;
}

/** Canonical full API base, retaining a path-prefixed gateway when present. */
export function canonicalApiBaseUrl(
  input: string | null | undefined,
): string | null {
  const validation = validateApiUrl(input);
  if (!validation.ok) return null;
  try {
    const parsed = new URL(validation.url);
    const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    return `${parsed.origin}${pathname === "/" ? "" : pathname}`;
  } catch {
    return null;
  }
}

export function normalizePublicHttpsUrl(
  url: string | null | undefined,
  fallback: string,
): string {
  const v = (url ?? fallback).trim();
  try {
    const parsed = new URL(v);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return fallback;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return fallback;
  }
}

export function normalizeOptionalAssetBaseUrl(
  url: string | null | undefined,
): string | null {
  const value = (url ?? "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const localDevelopmentOrigin =
      !isProductionBuild() &&
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (
      (parsed.protocol !== "https:" && !localDevelopmentOrigin) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function normalizeOptionalHttpsOrigin(
  url: string | null | undefined,
): string | null {
  const value = (url ?? "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "" && parsed.pathname !== "/")
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function validateApiUrl(
  input: string | null | undefined,
): ApiUrlValidation {
  // Validate the RAW input before normalizing — normalizeApiUrl maps
  // empty/blank input to DEFAULT_API_URL, which would silently make
  // the "required" branch unreachable.
  if (!(input ?? "").trim()) {
    return { ok: false, message: "API URL is required." };
  }
  const url = normalizeApiUrl(input);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: "API URL must be a valid http(s) URL." };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      message: "API URL must start with http:// or https://.",
    };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      message: "API URL must not include credentials.",
    };
  }

  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      message: "API URL must not include a query string or fragment.",
    };
  }

  if (isProductionBuild() && parsed.protocol !== "https:") {
    return {
      ok: false,
      message: "Packaged production builds must connect over HTTPS.",
    };
  }

  if (isProductionBuild() && isLocalHost(parsed.hostname)) {
    return {
      ok: false,
      message: "Packaged production builds cannot connect to local API hosts.",
    };
  }

  return { ok: true, url };
}

export function isProductionBuild(): boolean {
  const profile = (
    env.VITE_BUILD_PROFILE || (env.DEV ? "development" : "production")
  ).toLowerCase();
  return profile === "production";
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h.endsWith(".local")
  );
}
