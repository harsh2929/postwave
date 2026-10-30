/**
 * lib/chatChannels.ts — the shape of a Slack / Discord / Teams alert channel.
 *
 * Pure by design and therefore in `src/lib`: `src/api` transitively imports
 * react-native through the request layer, so a parser living there cannot be tested
 * under node. This is the same seam that keeps every other policy module testable.
 *
 * INTEG#7 — see api/chatIntegrations for the routes.
 */
export type ChatProvider = "slack" | "discord" | "teams";

export const CHAT_PROVIDERS: readonly ChatProvider[] = [
  "slack",
  "discord",
  "teams",
];

export const CHAT_PROVIDER_LABELS: Readonly<Record<ChatProvider, string>> = {
  slack: "Slack",
  discord: "Discord",
  teams: "Teams",
};

export interface ChatChannel {
  id: string;
  provider: ChatProvider;
  name: string;
  active: boolean;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseChatChannels(
  provider: ChatProvider,
  payload: unknown,
): ChatChannel[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as Record<string, unknown>).items ??
          (payload as Record<string, unknown>).integrations)
      : null;
  if (!Array.isArray(rows)) return [];
  const out: ChatChannel[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = str(row.id);
    if (!id) continue;
    out.push({
      id,
      provider,
      name:
        str(row.name) ||
        str(row.channel) ||
        str(row.channel_name) ||
        CHAT_PROVIDER_LABELS[provider],
      // Absent means ACTIVE: these rows are created enabled, and rendering a
      // working channel as disabled would have someone "fix" a channel that is
      // fine.
      active: row.active === undefined ? true : row.active === true,
    });
  }
  return out;
}

/**
 * Fold the three per-provider reads into one list.
 *
 * PARTIAL failure is absorbed on purpose — one revoked Slack webhook must not
 * hide the Discord and Teams rows next to it. TOTAL failure is NOT, and that
 * distinction is the whole point of this function. Flattening "every provider
 * refused" into `[]` produced a SUCCESSFUL query holding an empty list, so the
 * panel that renders only when it has rows disappeared from the integrations
 * screen entirely — and an operator checking whether their alerts are silenced
 * read a fetch failure as "this workspace has no alert channels".
 *
 * Throws the first rejection so TanStack reports `isError` and the panel can
 * say what actually happened.
 */
export function foldChatChannelResults(
  settled: readonly PromiseSettledResult<ChatChannel[]>[],
): ChatChannel[] {
  const fulfilled = settled.filter(
    (result): result is PromiseFulfilledResult<ChatChannel[]> =>
      result.status === "fulfilled",
  );
  if (settled.length > 0 && fulfilled.length === 0) {
    const first = settled[0] as PromiseRejectedResult;
    throw first.reason instanceof Error
      ? first.reason
      : new Error(String(first.reason ?? "Alert channels could not be read."));
  }
  return fulfilled.flatMap((result) => result.value);
}

