import type { ApiResult } from "./result";
import {
  responseContractFailure,
  responseIdentityMatches,
  responseIdentityMismatch,
} from "./subscriber-response-integrity";
import type {
  SubscriberProfilesRequester,
  SubscriberUpdateRequestOptions,
} from "./subscriber-profiles";

/** Reachability channels exposed by the unified subscriber consent view. */
export type ChannelConsentChannel =
  | "email"
  | "sms"
  | "push"
  | "whatsapp"
  | "rcs";

/** Unified per-channel consent state. */
export type ChannelConsentStatus =
  | "opted_in"
  | "opted_out"
  | "pending"
  | "unknown";

/** One persisted (subscriber, channel) projection. */
export interface ChannelConsent {
  id: string;
  subscriber_id: string;
  /** Fresh strong parent-profile revision returned by PATCH. */
  subscriber_version?: string;
  channel: ChannelConsentChannel;
  status: ChannelConsentStatus;
  /** When the current status was recorded. null = never recorded. */
  consent_timestamp?: string | null;
  consent_source?: string;
  /** Shared frequency cap — sends are held until this passes. null = none. */
  frequency_cap_until?: string | null;
  email?: string;
  phone_e164?: string;
  created_at?: string;
  updated_at?: string;
}

/** PATCH body for one channel projection and its reviewed evidence. */
export interface UpdateChannelConsentInput {
  status?: ChannelConsentStatus;
  consent_source?: string;
  consent_timestamp?: string | null;
  evidence_channel?: string;
  legal_basis?: string;
  evidence?: string;
  jurisdiction?: string;
  reason?: string;
  policy_version?: string;
  frequency_cap_until?: string | null;
  /** Distinguishes clearing the cap from leaving it unchanged. */
  clear_frequency_cap?: boolean;
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** GET /api/v1/subscribers/{id}/channel-consents. */
export function createListSubscriberChannelConsents(
  request: SubscriberProfilesRequester,
) {
  return function listSubscriberChannelConsents(
    id: string | number,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<{ items: ChannelConsent[] }>> {
    return request<{ items: ChannelConsent[] }>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/channel-consents`,
      undefined,
      opts.signal ? { signal: opts.signal } : undefined,
    );
  };
}

/**
 * PATCH /api/v1/subscribers/{id}/channel-consents/{channel}.
 *
 * Consent writes are online-only, single-attempt operations. The exact
 * parent-profile revision prevents a channel decision from racing another
 * subscriber mutation, and the response must bind the same fresh revision in
 * both its body and ETag header before the client accepts success.
 */
export function createSetSubscriberChannelConsent(
  request: SubscriberProfilesRequester,
) {
  return async function setSubscriberChannelConsent(
    id: string | number,
    channel: ChannelConsentChannel,
    input: UpdateChannelConsentInput,
    opts: SubscriberUpdateRequestOptions,
  ): Promise<ApiResult<ChannelConsent>> {
    const version = trimmedString(opts?.version);
    if (!version || version === "*") {
      return {
        error: {
          kind: "http",
          status: 428,
          code: "precondition_required",
          message:
            "Reload this subscriber before changing consent so the latest exact revision can be verified.",
        },
        retryability: "not-retryable",
        preservedDraft: input,
      };
    }
    const { version: _version, ...transportOptions } = opts;
    const response = await request<ChannelConsent>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/channel-consents/${encodeURIComponent(channel)}`,
      {
        method: "PATCH",
        headers: { "If-Match": version },
        body: JSON.stringify(input),
      },
      { ...transportOptions, maxAttempts: 1, requireOnline: true },
    );
    if (response.error) return response;
    if (!responseIdentityMatches(id, response.data.subscriber_id)) {
      return responseIdentityMismatch("subscriber");
    }
    if (
      !trimmedString(response.data.subscriber_version) ||
      !trimmedString(response.serverVersion) ||
      response.data.subscriber_version !== response.serverVersion
    ) {
      return responseContractFailure(
        "The server did not return one matching subscriber revision in the consent response and ETag header. The previous verified data was kept; refresh before trying again.",
      );
    }
    return response;
  };
}
