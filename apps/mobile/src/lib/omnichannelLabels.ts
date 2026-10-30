/**
 * lib/omnichannelLabels.ts — how a channel key is SPOKEN.
 *
 * Its own module rather than a constant inside the row component, because the
 * detail sheet needs the same map and a component importing a sibling component
 * purely for a string table is how two spellings of "WhatsApp" end up on one
 * screen. Import-free, so the mapping is checkable in the node vitest
 * environment.
 *
 * The keys are the catalog's own (omnichannel.go:236-242). An UNKNOWN key is
 * returned verbatim rather than mapped to "Other": a definition naming a channel
 * this build has never heard of should show what it actually says, so the reader
 * can tell a typo from a newer server.
 */
export const OMNI_CHANNEL_LABEL: Readonly<Record<string, string>> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
  rcs: "RCS",
  push: "Push",
};

export function channelLabel(channel: string): string {
  const key = channel.trim();
  return OMNI_CHANNEL_LABEL[key] ?? key;
}

/**
 * "Email only" / "Email and SMS" / "3 channels: Email, SMS, WhatsApp" — the
 * spoken form of a definition's span.
 *
 * The zero case is its own sentence. A definition with no paths is possible in
 * the table (`Validate` requires at least one only on the create route), and
 * "0 channels: " is not something a screen reader should ever say.
 */
export function channelSpanSpeech(channels: readonly string[]): string {
  const named = channels.map(channelLabel);
  if (named.length === 0) return "No channel paths";
  if (named.length === 1) return `${named[0]} only`;
  if (named.length === 2) return `${named[0]} and ${named[1]}`;
  return `${named.length} channels: ${named.join(", ")}`;
}
