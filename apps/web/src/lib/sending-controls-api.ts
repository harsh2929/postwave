// SPDX-License-Identifier: AGPL-3.0-only
//
// Email sending pause/readiness client.

import { api } from "./api";

export interface EmailSendingControl {
  tenant_id: string;
  paused: boolean;
  pause_reason?: string;
  pause_changed_at?: string;
  pause_changed_by?: string;
  source: string;
}

export interface SendingReadinessItem {
  key: string;
  label: string;
  complete: boolean;
  severity: "blocker" | "warning" | string;
  detail?: string;
}

export interface SendingReadiness {
  ready: boolean;
  items: SendingReadinessItem[];
  controls: EmailSendingControl;
  compliance: {
    exists: boolean;
    complete: boolean;
    verified_sender_domain: boolean;
    list_unsubscribe_enabled: boolean;
    one_click_unsubscribe_enabled: boolean;
    legal_sender_name?: string;
    compliance_contact_email?: string;
    missing_physical_address: boolean;
    missing_compliance_email: boolean;
    missing_legal_sender_name: boolean;
  };
  settings: {
    exists: boolean;
    max_sends_per_hour?: number;
    quiet_hours_start?: string;
    quiet_hours_end?: string;
    quiet_hours_tz?: string;
    quiet_hours_enabled: boolean;
    /** SETA-041: STO cold-start fallback send hour (0–23 UTC). */
    fallback_hour_utc?: number;
  };
  warmup_started: boolean;
  warmup_day?: number;
  todays_cap?: number;
  todays_sent?: number;
  sending_provisioned: boolean;
}

export const sendingControlsApi = {
  get: () => api.get<EmailSendingControl>("/api/v1/sending/controls"),
  readiness: () => api.get<SendingReadiness>("/api/v1/sending/readiness"),
  pause: (reason: string, signal?: AbortSignal) =>
    api.post<EmailSendingControl>("/api/v1/sending/controls/pause", {
      reason,
    }, { signal, requireOnline: true, maxAttempts: 1 }),
  resume: (signal?: AbortSignal) =>
    api.post<EmailSendingControl>("/api/v1/sending/controls/resume", undefined, { signal, requireOnline: true, maxAttempts: 1 }),
};
