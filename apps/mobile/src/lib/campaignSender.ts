/**
 * lib/campaignSender.ts — the campaign's From identity, read from where the
 * gateway actually puts it.
 *
 * The detail screen rendered a "From: …" line behind `campaign.from_email`.
 * That field does not exist on the Go `Campaign` struct
 * (apps/api/internal/campaigns/types.go has `from_name` and `reply_to` but no
 * `from_email`); the sending address lives inside the JSON blob at
 * `delivery_settings.from_email`, which is exactly where the send path reads
 * it (apps/api/internal/campaigns/send.go:128) and where the A/B winner
 * rollout writes it (abrollout.go:114). So the line was permanently absent —
 * the one identity fact a pre-send screen most needs to show was never shown.
 *
 * src/lib/campaignWireContract.test.ts is what caught this: it compares the
 * mobile mirror against the Go struct's json tags.
 */

export interface CampaignSenderFields {
  from_name?: string | null | undefined;
  reply_to?: string | null | undefined;
  /**
   * Accepted as a forward-compatible alias only. The gateway does not send a
   * top-level `from_email` today; `delivery_settings.from_email` is canonical.
   */
  from_email?: string | null | undefined;
  delivery_settings?: unknown;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The sending address, or null when the campaign inherits the workspace default. */
export function campaignFromEmail(
  campaign: CampaignSenderFields | null | undefined,
): string | null {
  if (!campaign) return null;
  const settings = campaign.delivery_settings;
  if (settings && typeof settings === "object") {
    const direct = trimmed((settings as { from_email?: unknown }).from_email);
    if (direct) return direct;
  }
  const top = trimmed(campaign.from_email);
  return top || null;
}

/**
 * The full From line, e.g. `Acme <hello@acme.com>` / `hello@acme.com` /
 * `Acme` — or null when neither half is set, so the caller renders nothing
 * rather than a label with an empty value.
 */
export function campaignFromLine(
  campaign: CampaignSenderFields | null | undefined,
): string | null {
  const email = campaignFromEmail(campaign);
  const name = trimmed(campaign?.from_name);
  if (email && name) return `${name} <${email}>`;
  if (email) return email;
  return name || null;
}

/** The reply-to address when it differs from the From address. */
export function campaignReplyTo(
  campaign: CampaignSenderFields | null | undefined,
): string | null {
  const reply = trimmed(campaign?.reply_to);
  if (!reply) return null;
  return reply.toLowerCase() === (campaignFromEmail(campaign) ?? "").toLowerCase()
    ? null
    : reply;
}
