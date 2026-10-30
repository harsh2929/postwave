/**
 * lib/byok-api.ts — customer-managed encryption keys.
 *
 * Two `/api/v1/byok/*` paths were reached by desktop and by no web file.
 *
 * `/providers` returns TWO lists and they mean different things:
 *
 *   supported  KMS providers this build can talk to
 *   providers  the ones this workspace has actually configured
 *
 * Rendering `supported` as though it were `providers` tells an operator their
 * data is under their own key when it is not — the single most consequential
 * misreading available on an encryption screen. They are kept as separate
 * fields with separate names here rather than merged into one "providers"
 * array.
 */
import { api } from "@/lib/api";

export interface ByokKey {
  id?: string;
  provider?: string;
  alias?: string;
  status?: string;
  [k: string]: unknown;
}

export interface ByokProviders {
  /** Configured by this workspace. */
  providers: unknown[];
  /** Available in this build — NOT the same thing. */
  supported: unknown[];
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function listByokKeys(): Promise<ByokKey[]> {
  const res = await api.get<{ keys?: unknown }>("/api/v1/byok/keys");
  return asArray<ByokKey>(res?.keys);
}

export async function getByokProviders(): Promise<ByokProviders> {
  const res = await api.get<ByokProviders>("/api/v1/byok/providers");
  return {
    providers: asArray(res?.providers),
    supported: asArray(res?.supported),
  };
}
