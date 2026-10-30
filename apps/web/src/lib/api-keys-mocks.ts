// SPDX-License-Identifier: AGPL-3.0-only

import type {
  ApiKey,
  ApiKeyScope,
  CreateApiKeyInput,
  CreateApiKeyResponse,
  RotateApiKeyResponse,
} from "./api-keys-api";

const NOW = () => new Date().toISOString();

const KEYS: ApiKey[] = [
  {
    id: "k_01",
    tenantId: "tenant_demo",
    label: "Production / Zapier",
    prefix: "pw_live_4tA7",
    scopes: ["read:subscribers", "write:subscribers", "send:transactional"],
    createdAt: "2026-01-08T09:00:00Z",
    lastUsedAt: "2026-04-30T18:48:00Z",
  },
  {
    id: "k_02",
    tenantId: "tenant_demo",
    label: "Analytics dashboard",
    prefix: "pw_live_9hB2",
    scopes: ["read:subscribers", "read:campaigns", "read:reports"],
    createdAt: "2026-02-19T13:00:00Z",
    lastUsedAt: "2026-04-29T08:11:00Z",
  },
  {
    id: "k_03",
    tenantId: "tenant_demo",
    label: "Old script (rotate me)",
    prefix: "pw_live_pK19",
    scopes: ["read:subscribers"],
    createdAt: "2025-09-04T10:00:00Z",
    lastUsedAt: null,
    sandboxOnly: true,
  },
];

function randomHex(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

export function mockListApiKeys(): ApiKey[] {
  return KEYS.filter((k) => !k.revokedAt).map((k) => ({ ...k }));
}

export function mockCreateApiKey(
  input: CreateApiKeyInput,
): CreateApiKeyResponse {
  const head = randomHex(4);
  const tail = randomHex(48);
  const prefix = `pw_live_${head}`;
  const plaintext = `${prefix}_${tail}`;
  const scopes: ApiKeyScope[] = [...input.scopes];
  const k: ApiKey = {
    id: `k_${Date.now()}`,
    tenantId: "tenant_demo",
    label: input.label,
    prefix,
    scopes,
    createdAt: NOW(),
    lastUsedAt: null,
    sandboxOnly: input.sandbox_only === true,
  };
  KEYS.unshift(k);
  return { key: k, plaintext };
}

export function mockRevokeApiKey(id: string): void {
  const idx = KEYS.findIndex((k) => k.id === id);
  if (idx >= 0) KEYS[idx] = { ...KEYS[idx], revokedAt: NOW() };
}

export function mockRotateApiKey(id: string): RotateApiKeyResponse {
  const old = KEYS.find((key) => key.id === id && !key.revokedAt);
  if (!old) throw new Error("not_found");
  mockRevokeApiKey(id);
  const created = mockCreateApiKey({
    label: old.label,
    scopes: old.scopes,
    sandbox_only: old.sandboxOnly,
  });
  return { ...created, revoked_id: id };
}
