/**
 * api/chatIntegrations.ts — Slack / Discord / Teams notification channels.
 *
 * INTEG#7. `app/(tabs)/integrations.tsx` names exactly these three and tells the
 * operator to "Connect Slack, Discord, Teams, or a custom webhook on the web
 * admin" — which was right about CONNECTING and wrong about everything after it.
 * The phone could see a channel failing and could not send a test, could not
 * disable one that was flooding, and could not read the delivery log.
 *
 * All three providers expose an identical shape, every route ScopeAdmin
 * (apps/api/internal/server/collaboration_integrations.go:36-61):
 *
 *   GET    /api/v1/integrations/{provider}
 *   PATCH  /api/v1/integrations/{provider}/{id}        { active }
 *   DELETE /api/v1/integrations/{provider}/{id}
 *   POST   /api/v1/integrations/{provider}/{id}/test
 *   GET    /api/v1/integrations/{provider}/{id}/deliveries
 *
 * CREATING one stays on the web admin, and that is not an omission: it needs an
 * incoming-webhook URL pasted from the provider's own console, which is desk work.
 */
import { rawRequest } from "@/api/request";
import {
  parseChatChannels,
  type ChatChannel,
  type ChatProvider,
} from "@/lib/chatChannels";

export {
  CHAT_PROVIDERS,
  CHAT_PROVIDER_LABELS,
  parseChatChannels,
  type ChatChannel,
  type ChatProvider,
} from "@/lib/chatChannels";

export async function fetchChatChannels(
  provider: ChatProvider,
): Promise<ChatChannel[]> {
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/integrations/${provider}`,
  );
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
  return parseChatChannels(provider, res.data);
}

function channelPath(channel: ChatChannel, suffix = ""): string {
  const id = channel.id.trim();
  if (!id) throw new Error("channel id is required");
  return `/api/v1/integrations/${channel.provider}/${encodeURIComponent(id)}${suffix}`;
}

/** Fire one real notification down the channel. */
export async function testChatChannel(channel: ChatChannel): Promise<void> {
  const res = await rawRequest<unknown>("POST", channelPath(channel, "/test"), {});
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
}

/** Enable or silence a channel without deleting its configuration. */
export async function setChatChannelActive(
  channel: ChatChannel,
  active: boolean,
): Promise<void> {
  const res = await rawRequest<unknown>("PATCH", channelPath(channel), {
    active,
  });
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
}
