/**
 * lib/bot-opens-api.ts — machine-opened mail.
 *
 * Two `/api/v1/bot-opens/*` paths were reached by desktop and by no web file.
 *
 * WHY THIS MATTERS MORE THAN IT SOUNDS. Since Apple Mail Privacy Protection,
 * a large share of "opens" are prefetches by a machine, not a person reading.
 * `/stats` splits total opens into `bot_opens` and `human_opens` against 18
 * detection signatures, and the split is what makes an open rate meaningful.
 *
 * `total_opens` is reported separately from the two parts, so a client can tell
 * an unclassified remainder from a genuine zero. That distinction is kept here
 * rather than assuming bot + human == total.
 */
import { api } from "@/lib/api";

export interface BotOpenStats {
  bot_opens: number;
  human_opens: number;
  total_opens: number;
  by_signature: unknown[];
  since?: string;
}

export interface BotSignature {
  id: string;
  label: string;
  pattern: string;
  kind?: string;
  is_default: boolean;
  enabled: boolean;
  created_at?: string;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function num(v: unknown): number {
  return Number.isFinite(v) ? Number(v) : 0;
}

export async function getBotOpenStats(): Promise<BotOpenStats> {
  const res = await api.get<BotOpenStats>("/api/v1/bot-opens/stats");
  return {
    bot_opens: num(res?.bot_opens),
    human_opens: num(res?.human_opens),
    total_opens: num(res?.total_opens),
    by_signature: asArray(res?.by_signature),
    since: res?.since,
  };
}

export async function listBotSignatures(): Promise<BotSignature[]> {
  const res = await api.get<{ signatures?: unknown }>(
    "/api/v1/bot-opens/signatures",
  );
  return asArray<BotSignature>(res?.signatures);
}

/**
 * Opens that matched neither a bot signature nor a human classification.
 *
 * Never negative: a server that reports parts summing above the total should
 * not make this page render a nonsense figure.
 */
export function unclassifiedOpens(s: BotOpenStats): number {
  return Math.max(0, s.total_opens - s.bot_opens - s.human_opens);
}
