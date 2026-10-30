// SPDX-License-Identifier: MIT

import Conf from "conf";

export interface StoredCredentials {
  apiKey: string;
  baseUrl?: string;
  tenantId?: string;
  email?: string;
  storedAt: string;
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const schema = {
  credentials: {
    type: "object",
    properties: {
      apiKey: { type: "string" },
      baseUrl: { type: "string" },
      tenantId: { type: "string" },
      email: { type: "string" },
      storedAt: { type: "string" },
    },
  },
} as const;

export const config = new Conf<{ credentials?: StoredCredentials }>({
  projectName: "postwave",
  schema: schema as never,
});

export function setCredentials(c: StoredCredentials): void {
  if (!isSafeCredentialValue(c.apiKey)) {
    throw new Error("Refusing to store unsafe API key.");
  }
  if (c.baseUrl !== undefined && hasUnsafeStoredValue(c.baseUrl)) {
    throw new Error("Refusing to store unsafe base URL.");
  }
  if (c.tenantId !== undefined && hasUnsafeStoredValue(c.tenantId)) {
    throw new Error("Refusing to store unsafe tenant ID.");
  }
  if (c.email !== undefined && hasUnsafeStoredValue(c.email)) {
    throw new Error("Refusing to store unsafe email.");
  }
  config.set("credentials", c);
}

export function getCredentials(): StoredCredentials | undefined {
  return config.get("credentials");
}

export function clearCredentials(): void {
  config.delete("credentials");
}

export function resolveApiKey(flag?: string): string | undefined {
  if (flag) return flag;
  if (process.env.POSTWAVE_API_KEY) return process.env.POSTWAVE_API_KEY;
  return getCredentials()?.apiKey;
}

export function resolveBaseUrl(flag?: string): string {
  return (
    flag ||
    process.env.POSTWAVE_BASE_URL ||
    getCredentials()?.baseUrl ||
    "https://api.moosewave.com"
  );
}

export function resolveTenantId(flag?: string): string | undefined {
  return (
    flag ||
    process.env.POSTWAVE_TENANT_ID ||
    getCredentials()?.tenantId
  );
}

export function isSafeCredentialValue(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  return Boolean(trimmed) && trimmed === raw && trimmed.length <= 4096 && !CONTROL_RE.test(trimmed);
}

function hasUnsafeStoredValue(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed !== raw || trimmed.length > 4096 || CONTROL_RE.test(trimmed);
}
