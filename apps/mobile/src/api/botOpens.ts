/**
 * api/botOpens.ts — how much of the open rate is machines, and the signature
 * list that decides it.
 *
 *   GET    /api/v1/bot-opens/stats             (viewer)
 *   GET    /api/v1/bot-opens/signatures        (viewer)
 *   POST   /api/v1/bot-opens/signatures        (admin)
 *   DELETE /api/v1/bot-opens/signatures/{id}   (admin)
 *
 * Default signatures ship with no tenant_id and cannot be deleted from here;
 * `isDefault` carries that difference so the UI never offers a delete that can
 * only 404.
 */
import { rawRequest, type AIApiError } from "./request";

import { itemsOf, numberOr, str, WireShapeError } from "@/lib/deliverabilityContracts";

class BotOpensError extends Error {
  readonly status: number;

  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "BotOpensError";
    this.status = error.status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface BotOpenStats {
  totalOpens: number;
  botOpens: number;
  humanOpens: number;
  since: string;
  bySignature: { label: string; opens: number }[];
}

export async function fetchBotOpenStats(): Promise<BotOpenStats> {
  const res = await rawRequest<unknown>("GET", "/api/v1/bot-opens/stats");
  if (res.error) {
    throw new BotOpensError(res.error, "Couldn't load bot-open stats.");
  }
  if (!isRecord(res.data)) throw new WireShapeError("bot-open stats");
  const bySignature: { label: string; opens: number }[] = [];
  for (const row of itemsOf(res.data.by_signature ?? [], "bot-open buckets")) {
    if (!isRecord(row)) continue;
    const label = str(row.label).trim();
    if (!label) continue;
    bySignature.push({ label, opens: Math.max(0, numberOr(row.opens, 0)) });
  }
  return {
    totalOpens: Math.max(0, numberOr(res.data.total_opens, 0)),
    botOpens: Math.max(0, numberOr(res.data.bot_opens, 0)),
    humanOpens: Math.max(0, numberOr(res.data.human_opens, 0)),
    since: str(res.data.since),
    bySignature,
  };
}

export interface BotOpenSignature {
  id: string;
  label: string;
  pattern: string;
  kind: string;
  enabled: boolean;
  /** Platform-shipped rows have no tenant and cannot be deleted per-tenant. */
  isDefault: boolean;
}

function parseSignature(row: Record<string, unknown>): BotOpenSignature | null {
  const id = str(row.id).trim();
  if (!id) return null;
  return {
    id,
    label: str(row.label),
    pattern: str(row.pattern),
    kind: str(row.kind),
    enabled: row.enabled === true,
    isDefault: row.is_default === true || str(row.tenant_id).trim() === "",
  };
}

export async function fetchBotOpenSignatures(): Promise<BotOpenSignature[]> {
  const res = await rawRequest<unknown>("GET", "/api/v1/bot-opens/signatures");
  if (res.error) {
    throw new BotOpensError(res.error, "Couldn't load bot-open signatures.");
  }
  const out: BotOpenSignature[] = [];
  for (const row of itemsOf(res.data, "bot-open signatures")) {
    if (!isRecord(row)) continue;
    const parsed = parseSignature(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function createBotOpenSignature(input: {
  label: string;
  pattern: string;
}): Promise<void> {
  const res = await rawRequest<unknown>("POST", "/api/v1/bot-opens/signatures", {
    label: input.label,
    pattern: input.pattern,
  });
  if (res.error) {
    throw new BotOpensError(res.error, "Couldn't add the signature.");
  }
}

export async function deleteBotOpenSignature(id: string): Promise<void> {
  const res = await rawRequest<unknown>(
    "DELETE",
    `/api/v1/bot-opens/signatures/${encodeURIComponent(id)}`,
  );
  if (res.error) {
    throw new BotOpensError(res.error, "Couldn't remove the signature.");
  }
}
