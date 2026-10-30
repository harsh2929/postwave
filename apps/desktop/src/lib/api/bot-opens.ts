// Typed client for the bot-open filter (apps/api/internal/bot_open_filter),
// mounted at /api/v1/bot-opens/*. The backend classifies tracked "open" events
// by user-agent to separate real human engagement from automated prefetchers
// (Apple Mail Privacy Protection, Gmail image proxy, SafeLinks, link unfurlers,
// scanners) — with signature CRUD + a stats breakdown, but no client. Shapes
// verified against bot_open_filter.go.
import type { ApiRequester, ApiResult } from "./result";

export interface BotOpenSignature {
  id: string;
  tenant_id?: string;
  is_default: boolean;
  label: string;
  pattern: string;
  kind: string;
  enabled: boolean;
  created_at: string;
}

export interface CreateSignatureInput {
  label: string;
  pattern: string;
  kind: string;
}

export interface BotOpenStats {
  since: string;
  total_opens: number;
  bot_opens: number;
  human_opens: number;
  by_signature: { label: string; opens: number }[];
}

interface SignaturesEnvelope {
  signatures: BotOpenSignature[];
  count: number;
}

// createBotOpensApi wires the mounted bot-open-filter routes.
export function createBotOpensApi(request: ApiRequester) {
  return {
    // GET /api/v1/bot-opens/signatures — the tenant's + default signatures.
    listSignatures(): Promise<ApiResult<BotOpenSignature[]>> {
      return request<SignaturesEnvelope>("/api/v1/bot-opens/signatures").then(
        (res) => {
          if (res.error) return res;
          const envelope = res.data as unknown as {
            signatures?: unknown;
          } | null;
          return { data: envelope?.signatures as BotOpenSignature[] };
        },
      );
    },

    // POST /api/v1/bot-opens/signatures — add a custom signature (admin).
    createSignature(
      input: CreateSignatureInput,
    ): Promise<ApiResult<{ id: string }>> {
      return request<{ id: string }>("/api/v1/bot-opens/signatures", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    },

    // DELETE /api/v1/bot-opens/signatures/{id} — remove a custom signature (admin).
    deleteSignature(id: string): Promise<ApiResult<void>> {
      return request<void>(
        `/api/v1/bot-opens/signatures/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
        },
      );
    },

    // GET /api/v1/bot-opens/stats?since= — human vs bot open breakdown.
    // `since` is RFC3339; the server defaults to the trailing 30 days.
    stats(since?: string): Promise<ApiResult<BotOpenStats>> {
      const q = since ? `?since=${encodeURIComponent(since)}` : "";
      return request<BotOpenStats>(`/api/v1/bot-opens/stats${q}`);
    },
  };
}

export type BotOpensApi = ReturnType<typeof createBotOpensApi>;
