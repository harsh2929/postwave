// SPDX-License-Identifier: AGPL-3.0-only
//
// sms-a2p-api.ts — small standalone desktop client methods for SMS surfaces
// that were missing typed wrappers in the 20k-line api-client.ts: the A2P
// 10DLC registration flow, mid-flight campaign controls, and the SMS lists
// read the broadcast audience picker needs. The gateway already implements
// these endpoints (apps/api/internal/sms/handlers.go a2p/* + /sms/lists +
// campaigns send-domain pause|resume|cancel). Kept here so the surface is
// reviewable and decoupled.

import { apiRequest, type ApiResult } from "./api-client";

// --- SMS lists (broadcast audience picker) ------------------------------

/**
 * One SMS list as GET /api/v1/sms/lists returns it — an `sms_lists` row with
 * a UUID `id`. Deliberately DISTINCT from the Listmonk email `List`
 * (int64 id, api.listLists): the SMS broadcast audience resolver joins
 * `sms_subscriptions.list_id` on these UUIDs, and normalizeBroadcastUpsert
 * (broadcasts.go) rejects non-UUID `list_ids` with 422 `invalid_audience`
 * ("list_ids entries must be UUIDs"). The broadcast composer MUST source its
 * list checkboxes from here, not from the email lists.
 */
export interface SmsList {
  id: string;
  name: string;
  description?: string;
  keyword?: string;
  sender_profile_id?: string;
  created_at?: string;
  updated_at?: string;
}

/** List the tenant's SMS lists (sms_lists, UUID ids). Response envelope is
 *  `{ items: SmsList[] }` (sms/handlers.go ListLists). Reads ride
 *  read:subscribers scope on the gateway. */
export function listSmsLists(): Promise<ApiResult<{ items: SmsList[] }>> {
  return apiRequest<{ items: SmsList[] }>("/api/v1/sms/lists");
}

// --- A2P 10DLC registration ---------------------------------------------

/** A2P Brand registration submission. Field names mirror the gateway's
 *  A2PBrandRegistrationInput; passed through to the provider (Twilio etc.). */
export interface A2PBrandRegistrationInput {
  /** Provider TrustHub / A2P profile bundle SID (Twilio). */
  a2p_profile_bundle_sid?: string;
  /** STANDARD | SOLE_PROPRIETOR | LOW_VOLUME. */
  brand_type?: string;
  legal_business_name?: string;
  ein?: string;
  [key: string]: unknown;
}

/** A2P Campaign (use-case) registration submission. */
export interface A2PCampaignRegistrationInput {
  brand_registration_sid?: string;
  use_case?: string;
  description?: string;
  message_samples?: string[];
  privacy_policy_link?: string;
  terms_and_conditions_link?: string;
  [key: string]: unknown;
}

/** One brand/campaign registration resource as the gateway returns it. */
export interface SmsRegistrationResource {
  sid?: string;
  status?: string;
  raw?: Record<string, unknown>;
}

/** Result envelope returned by the A2P submit/poll endpoints. */
export interface A2PRegistrationResult {
  sender?: Record<string, unknown>;
  brand?: SmsRegistrationResource;
  campaign?: SmsRegistrationResource;
}

function senderPath(senderId: string, suffix: string): string {
  return `/api/v1/sms/senders/${encodeURIComponent(senderId)}/a2p/${suffix}`;
}

/** Submit the A2P 10DLC Brand registration for an SMS sender. */
export function submitA2PBrandRegistration(
  senderId: string,
  input: A2PBrandRegistrationInput,
): Promise<ApiResult<A2PRegistrationResult>> {
  return apiRequest<A2PRegistrationResult>(senderPath(senderId, "brand/submit"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Submit the A2P 10DLC Campaign (use-case) registration. Requires a prior
 *  Brand registration (the gateway 422s if absent). */
export function submitA2PCampaignRegistration(
  senderId: string,
  input: A2PCampaignRegistrationInput,
): Promise<ApiResult<A2PRegistrationResult>> {
  return apiRequest<A2PRegistrationResult>(senderPath(senderId, "campaign/submit"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Poll the provider for the current Brand + Campaign registration status. */
export function pollA2PRegistration(
  senderId: string,
): Promise<ApiResult<A2PRegistrationResult>> {
  return apiRequest<A2PRegistrationResult>(senderPath(senderId, "poll"), {
    method: "POST",
    body: JSON.stringify({}),
  });
}

// --- mid-flight campaign controls ---------------------------------------

export interface CampaignControlResult {
  ok?: boolean;
  status?: string;
}

function campaignControl(
  campaignId: string,
  action: "pause" | "resume" | "cancel",
): Promise<ApiResult<CampaignControlResult>> {
  return apiRequest<CampaignControlResult>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/${action}`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

/** Pause an in-flight campaign send. */
export function pauseCampaign(campaignId: string) {
  return campaignControl(campaignId, "pause");
}

/** Resume a paused campaign send. */
export function resumeCampaign(campaignId: string) {
  return campaignControl(campaignId, "resume");
}

/** Cancel a campaign send (terminal). */
export function cancelCampaign(campaignId: string) {
  return campaignControl(campaignId, "cancel");
}
