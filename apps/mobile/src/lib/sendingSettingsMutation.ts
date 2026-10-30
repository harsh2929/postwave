// SPDX-License-Identifier: AGPL-3.0-only

import type { PostwaveClient } from "@postwave/sdk";

import {
  isCanonicalSendsPerHour,
  sendingSettingsExpectedRevision,
  sendingSettingsMatchesTenant,
} from "./sendingForm";
import {
  isCanonicalNoRowProjection,
  isCanonicalSendingSettingsRow,
  sendingSettingsRevisionStrictlyAdvances,
  type SendingSettingsRow,
} from "./sendingSettingsSchema";

export {
  isCanonicalSendingSettingsRow,
  type SendingSettingsRow,
} from "./sendingSettingsSchema";

export interface SendingSettingsInput {
  max_sends_per_hour?: number | null;
  quiet_hours_start?: string;
  quiet_hours_end?: string;
  quiet_hours_tz?: string;
  quiet_hours_per_recipient?: boolean;
  expected_updated_at?: string;
}

export type SendingSettingsWriteInput = SendingSettingsInput & {
  expected_updated_at: string;
};

export type SendingSettingsMutationResult =
  | { kind: "applied"; settings: SendingSettingsRow }
  | { kind: "not-applied"; settings: SendingSettingsRow; message: string }
  | { kind: "conflict"; settings: SendingSettingsRow; message: string }
  | {
      kind: "pending";
      settings?: SendingSettingsRow;
      message: string;
      mutationDispatchedAt?: number;
    };

export const SENDING_SETTINGS_QUIESCENCE_MS = 35_000;

function monotonicNow(): number {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Number.NaN;
}

function optionalSettingsString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function statusHasReadyAuthority(
  status: Record<string, unknown>,
  expectedTenantId: string,
): boolean {
  return (
    status.tenant_id === expectedTenantId &&
    status.cap_coordination_state === "ready" &&
    status.cap_coordination_ready === true &&
    status.cap_coordination_matches_settings === true &&
    (status.cap_coordination_fence_started_at === undefined ||
      status.cap_coordination_fence_started_at === null) &&
    isCanonicalSendsPerHour(status.max_sends_per_hour) &&
    isCanonicalSendsPerHour(status.cap_coordination_cap)
  );
}

function statusMatchesRow(
  status: Record<string, unknown>,
  row: SendingSettingsRow,
): boolean {
  const cap = row.max_sends_per_hour ?? null;
  return (
    (status.max_sends_per_hour ?? null) === cap &&
    (status.cap_coordination_cap ?? null) === cap &&
    optionalSettingsString(status.quiet_hours_start) &&
    optionalSettingsString(status.quiet_hours_end) &&
    optionalSettingsString(status.quiet_hours_tz) &&
    (status.quiet_hours_start ?? "") === (row.quiet_hours_start ?? "") &&
    (status.quiet_hours_end ?? "") === (row.quiet_hours_end ?? "") &&
    (status.quiet_hours_tz ?? "") === (row.quiet_hours_tz ?? "") &&
    status.quiet_hours_per_recipient === row.quiet_hours_per_recipient
  );
}

export function sendingSettingsMatchInput(
  row: SendingSettingsRow,
  input: SendingSettingsWriteInput,
): boolean {
  return (
    (row.max_sends_per_hour ?? null) === (input.max_sends_per_hour ?? null) &&
    (row.quiet_hours_start ?? "") === (input.quiet_hours_start ?? "") &&
    (row.quiet_hours_end ?? "") === (input.quiet_hours_end ?? "") &&
    (row.quiet_hours_tz ?? "") === (input.quiet_hours_tz ?? "") &&
    row.quiet_hours_per_recipient === input.quiet_hours_per_recipient
  );
}

function statusProvesSettings(
  value: unknown,
  row: SendingSettingsRow,
  expectedTenantId: string,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const status = value as Record<string, unknown>;
  return (
    statusHasReadyAuthority(status, expectedTenantId) &&
    statusMatchesRow(status, row)
  );
}

/** Resolve an ambiguous write using GETs only; this never issues a second PUT. */
export async function reconcileSendingSettingsMutation(
  client: Pick<PostwaveClient, "request" | "sendingSettings">,
  input: SendingSettingsWriteInput,
  expectedTenantId: string,
  mutationDispatchedAt?: number,
): Promise<SendingSettingsMutationResult> {
  const reconciliationStartedAt = monotonicNow();
  const notAppliedProofAllowed = Boolean(
    Number.isFinite(mutationDispatchedAt) &&
    Number.isFinite(reconciliationStartedAt) &&
    reconciliationStartedAt >=
      (mutationDispatchedAt ?? Number.POSITIVE_INFINITY) &&
    reconciliationStartedAt - (mutationDispatchedAt ?? 0) >=
      SENDING_SETTINGS_QUIESCENCE_MS,
  );
  const pending = (
    message: string,
    settings?: SendingSettingsRow,
  ): SendingSettingsMutationResult => ({
    kind: "pending",
    ...(settings ? { settings } : {}),
    message,
    ...(typeof mutationDispatchedAt === "number" &&
    Number.isFinite(mutationDispatchedAt)
      ? { mutationDispatchedAt }
      : {}),
  });
  const [settingsResult, statusResult] = await Promise.allSettled([
    client.sendingSettings.get(),
    client.request<unknown>("GET", "/api/v1/settings/sending/status"),
  ]);
  if (
    settingsResult.status !== "fulfilled" ||
    !isCanonicalSendingSettingsRow(settingsResult.value) ||
    !sendingSettingsMatchesTenant(settingsResult.value, expectedTenantId)
  ) {
    return pending(
      "The request outcome is still unknown because canonical settings could not be verified for this workspace. Restore connectivity and refresh to reconcile.",
    );
  }
  const row = settingsResult.value;
  const statusProvesCurrentSettings =
    statusResult.status === "fulfilled" &&
    statusProvesSettings(statusResult.value, row, expectedTenantId);
  if (input.expected_updated_at === "" && isCanonicalNoRowProjection(row)) {
    return notAppliedProofAllowed && statusProvesCurrentSettings
      ? {
          kind: "not-applied",
          settings: row,
          message:
            "No durable sending-settings row exists after the mutation window, so the first write did not apply. Your draft is intact and can be retried.",
        }
      : pending(
          "No durable row is visible yet, but the mutation window has not been proven quiescent with ready shared authority. Editing remains held until a fresh reconciliation.",
          row,
        );
  }
  const verifiedRevision = sendingSettingsExpectedRevision(row.updated_at);
  if (verifiedRevision === null || verifiedRevision === "") {
    return pending(
      "Canonical settings did not provide a durable revision. Editing remains held until the write outcome can be verified.",
      row,
    );
  }
  const settingsMatch = sendingSettingsMatchInput(row, input);
  if (verifiedRevision === input.expected_updated_at) {
    return notAppliedProofAllowed && statusProvesCurrentSettings
      ? {
          kind: "not-applied",
          settings: row,
          message:
            "The prior server revision is still current after the mutation window, so the change did not apply. Your draft is intact and can be retried.",
        }
      : pending(
          "The prior revision is still visible, but the mutation window has not been proven quiescent with ready shared authority. Editing remains held until a fresh reconciliation.",
          row,
        );
  }
  if (
    input.expected_updated_at !== "" &&
    !sendingSettingsRevisionStrictlyAdvances(
      verifiedRevision,
      input.expected_updated_at,
    )
  ) {
    return pending(
      "Canonical settings did not provide a revision newer than the submitted baseline. Editing remains held until the write outcome can be verified.",
      row,
    );
  }
  if (settingsMatch) {
    if (statusProvesCurrentSettings) {
      return { kind: "applied", settings: row };
    }
    return pending(
      "The settings are persisted, but shared sending-cap convergence is not yet verified. Sending remains conservatively protected; refresh to reconcile.",
      row,
    );
  }
  return {
    kind: "conflict",
    settings: row,
    message:
      "The server now has a different settings revision. Your draft is intact; review the current server version before making another change.",
  };
}

function statusFromThrown(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function outcomeFromThrown(error: unknown): string | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("responseMetadata" in error)
  ) {
    return null;
  }
  const metadata = (error as { responseMetadata?: unknown }).responseMetadata;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("sendingCapOutcome" in metadata)
  ) {
    return null;
  }
  const outcome = (metadata as { sendingCapOutcome?: unknown })
    .sendingCapOutcome;
  return typeof outcome === "string" ? outcome : null;
}

/**
 * Send one logical mutation. Every ambiguous response is resolved by reads,
 * never by replaying the PUT.
 */
export async function setSendingSettingsOnce(
  client: Pick<PostwaveClient, "request" | "sendingSettings">,
  input: SendingSettingsWriteInput,
  expectedTenantId: string,
): Promise<SendingSettingsMutationResult> {
  const mutationDispatchedAt = monotonicNow();
  try {
    const value: unknown = await client.sendingSettings.set(input);
    const committedRevision = isCanonicalSendingSettingsRow(value)
      ? sendingSettingsExpectedRevision(value.updated_at)
      : null;
    if (
      isCanonicalSendingSettingsRow(value) &&
      sendingSettingsMatchesTenant(value, expectedTenantId) &&
      sendingSettingsMatchInput(value, input) &&
      Boolean(committedRevision) &&
      sendingSettingsRevisionStrictlyAdvances(
        committedRevision ?? "",
        input.expected_updated_at,
      )
    ) {
      return { kind: "applied", settings: value };
    }
    return reconcileSendingSettingsMutation(
      client,
      input,
      expectedTenantId,
      mutationDispatchedAt,
    );
  } catch (error) {
    const status = statusFromThrown(error);
    // Every HTTP failure needs an exact receipt. `not-committed` is the only
    // disposition that makes a fresh manual attempt safe; a proxy-generated
    // 4xx with no/malformed proof can follow a durable commit just like a 5xx.
    if (
      status !== null &&
      status >= 400 &&
      outcomeFromThrown(error) === "not-committed"
    ) {
      throw error;
    }
    return reconcileSendingSettingsMutation(
      client,
      input,
      expectedTenantId,
      mutationDispatchedAt,
    );
  }
}
