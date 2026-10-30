/**
 * lib/social-capture-api.ts — social lead capture.
 *
 * WHY THIS EXISTS. Seven `/api/v1/social-capture/*` paths were reached by
 * desktop and by no web file.
 *
 * EVERY NETWORK IS CURRENTLY `runtime_status: "foundation"`. Confirmed against
 * the running server for all four (Instagram, Facebook, TikTok, generic
 * webhook). "Foundation" means the plumbing exists and the network is not live,
 * so a UI that lists these as connectable options invites an operator to set up
 * something that cannot run. The status is carried through deliberately, and
 * the page states it rather than hiding it behind a disabled button.
 *
 * COVERAGE: this module wires 3 of them:
 *   /api/v1/social-capture/auto-replies
 *   /api/v1/social-capture/catalog
 *   /api/v1/social-capture/tap-to-text
 * The remaining 4 are not called from web. The sentence above
 * describes the gap that was found, not the part that was closed.
 */
import { api } from "@/lib/api";

export interface SocialNetwork {
  key: string;
  label: string;
  /** "foundation" means built but not live. Never present these as ready. */
  runtime_status: string;
  [key: string]: unknown;
}

export interface SocialCaptureCatalog {
  networks: SocialNetwork[];
  schema_version?: unknown;
  rule_fields?: unknown;
  tap_to_text?: unknown;
}

export interface TapToTextRule {
  id: string;
  name?: string;
  keyword?: string;
  status?: string;
  destination_phone?: string;
  message_body?: string;
  [key: string]: unknown;
}

export interface AutoReply {
  id: string;
  name?: string;
  network?: string;
  status?: string;
  trigger_phrases?: string[];
  reply_template?: string;
  [key: string]: unknown;
}

export interface SocialCaptureLead {
  id?: string;
  network?: string;
  subscriber_email?: string;
  phone_e164?: string;
  external_user_id?: string;
  status?: string;
  created_at?: string;
  [key: string]: unknown;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function getSocialCaptureCatalog(): Promise<SocialCaptureCatalog> {
  const res = await api.get<SocialCaptureCatalog>(
    "/api/v1/social-capture/catalog",
  );
  return { ...res, networks: asArray<SocialNetwork>(res?.networks) };
}

export async function listTapToText(): Promise<TapToTextRule[]> {
  const res = await api.get<{ items?: unknown }>(
    "/api/v1/social-capture/tap-to-text",
  );
  return asArray<TapToTextRule>(res?.items);
}

export async function listAutoReplies(): Promise<AutoReply[]> {
  const res = await api.get<{ items?: unknown }>(
    "/api/v1/social-capture/auto-replies",
  );
  return asArray<AutoReply>(res?.items);
}

/** True when no network is live yet — every one is "foundation". */
export function allNetworksAreFoundation(
  networks: readonly SocialNetwork[],
): boolean {
  return (
    networks.length > 0 &&
    networks.every((n) => n.runtime_status === "foundation")
  );
}

/** Leads captured from social replies. */
export async function listSocialCaptureLeads(): Promise<SocialCaptureLead[]> {
  const r = await api.get<{ items?: unknown }>("/api/v1/social-capture/leads");
  return asArray<SocialCaptureLead>(r?.items);
}
