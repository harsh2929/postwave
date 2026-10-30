// SPDX-License-Identifier: MIT

import { Resource } from "./_base.js";

export type MobilePushPlatform = "ios" | "android";

export interface MobilePushDeviceKeyInput {
  /** Per-installation 32-byte random secret encoded as lowercase hexadecimal. */
  device_key: string;
}

export interface MobilePushDeviceRegistrationInput extends MobilePushDeviceKeyInput {
  /** Expo push token. The API encrypts it at rest and never returns it. */
  expo_push_token: string;
  platform: MobilePushPlatform;
  enabled_events?: string[];
}

export interface MobilePushDeviceResponse {
  device_id?: string;
  registered: boolean;
  delivery_enabled: boolean;
  enabled_events?: string[];
  registered_at?: string;
  /** Present on the quiet-hours response; absent from register/status/revoke. */
  quiet_hours?: MobilePushQuietHours;
}

/**
 * A do-not-disturb window for ONE physical installation.
 *
 * `start_local`/`end_local` are server-derived "HH:MM" projections of the minute
 * fields, matching the SMS quiet-hours shape so a client may render either form.
 * A window may wrap midnight (start 1260 = 21:00, end 540 = 09:00 is the default).
 */
export interface MobilePushQuietHours {
  enabled: boolean;
  /** 0-1439, minutes after local midnight. */
  start_minute: number;
  /** 0-1439, minutes after local midnight. */
  end_minute: number;
  start_local: string;
  end_local: string;
  /** IANA zone name. */
  timezone: string;
}

/**
 * A partial update: every field except `device_key` is optional, and an omitted
 * field leaves the stored value alone. So a client may flip `enabled` without
 * re-sending a window it never rendered.
 *
 * `start_minute` takes precedence over `start_local` when both are sent (and the
 * same for the end pair) — prefer sending one form.
 */
export interface MobilePushQuietHoursInput extends MobilePushDeviceKeyInput {
  enabled?: boolean;
  start_minute?: number;
  end_minute?: number;
  /** "HH:MM" 24-hour local time. */
  start_local?: string;
  /** "HH:MM" 24-hour local time. */
  end_local?: string;
  timezone?: string;
}

export interface MobilePushTestResult {
  ok: boolean;
  /** True when the push service accepted the ticket. */
  accepted: boolean;
  /**
   * The server's own caveat, verbatim: acceptance is not proof of handset
   * delivery, which the receipt worker reconciles later. Render it rather than
   * claiming a success the API does not claim.
   */
  note: string;
}

/**
 * First-party mobile installation lifecycle.
 *
 * Registration, status, and authenticated revocation require a dashboard
 * session. Possession revocation is intentionally unauthenticated so a client
 * can finish cleanup after logout; the 256-bit installation key is its proof.
 */
export class MobilePushResource extends Resource {
  register(
    input: MobilePushDeviceRegistrationInput,
  ): Promise<MobilePushDeviceResponse> {
    return this.client.request("POST", "/api/v1/mobile/push/devices", {
      body: input,
    });
  }

  status(input: MobilePushDeviceKeyInput): Promise<MobilePushDeviceResponse> {
    return this.client.request("POST", "/api/v1/mobile/push/devices/status", {
      body: input,
    });
  }

  revoke(input: MobilePushDeviceKeyInput): Promise<MobilePushDeviceResponse> {
    return this.client.request("POST", "/api/v1/mobile/push/devices/revoke", {
      body: input,
    });
  }

  revokePossession(input: MobilePushDeviceKeyInput): Promise<void> {
    return this.client.request("POST", "/api/public/mobile/push/revoke", {
      body: input,
    });
  }

  /**
   * Set this installation's do-not-disturb window.
   *
   * The window is stored and enforced SERVER-side, because APNs/FCM delivery
   * originates from the API and not from the app — a purely local toggle would be
   * a control that controls nothing.
   *
   * Never creates a device row: answers 404 `device_not_registered` when the
   * installation is unknown or was revoked mid-save, so the client re-registers
   * instead of retrying a doomed write.
   */
  setQuietHours(
    input: MobilePushQuietHoursInput,
  ): Promise<MobilePushDeviceResponse> {
    return this.client.request(
      "POST",
      "/api/v1/mobile/push/devices/quiet-hours",
      { body: input },
    );
  }

  /**
   * Send one real push down the whole chain to this installation.
   *
   * Proves server -> Expo -> APNs/FCM -> handset rather than showing an operator a
   * truncated token. Throttled to one per device per minute (429
   * `test_push_throttled`), and answers 502 `test_push_rejected` when the push
   * service rejects the device — that refusal is the answer the operator came for.
   */
  sendTest(input: MobilePushDeviceKeyInput): Promise<MobilePushTestResult> {
    return this.client.request("POST", "/api/v1/mobile/push/devices/test", {
      body: input,
    });
  }
}
