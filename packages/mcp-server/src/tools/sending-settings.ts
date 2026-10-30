// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

const HHMM = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM (24h)");
const HHMMOrEmpty = z.union([HHMM, z.literal("")]);
const PortableTimeZoneOrEmpty = z
  .string()
  .max(128)
  .refine((value) => value === "" || isPortableTimeZone(value), {
    message: "expected UTC or a portable IANA timezone",
  });
export const SENDING_SETTINGS_RECONCILIATION_WAIT_MS = 35_000;

export function sendingSettingsTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "sending_settings_get",
      description:
        "Read the tenant's sending throttle and quiet-hours configuration. Set include_coordination_status=true after an outcome-ambiguous write to also read the qualified shared-cap recovery proof. A missing or null max_sends_per_hour means no workspace-specific hourly ceiling; provider, quota, and safety controls still apply.",
      schema: z.object({
        include_coordination_status: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true },
      requiredScopes: ["admin"],
      handler: async (input) => {
        try {
          const settings = await client.sendingSettings.get();
          if (!input.include_coordination_status) return settings;
          return {
            settings,
            cap_coordination_status: await client.sendingSettings.status(),
          };
        } catch (err) {
          throw wrapErr("sending_settings_get", err);
        }
      },
    },
    {
      name: "sending_settings_set",
      description:
        "Replace the tenant's complete sending throttle and quiet-hours policy using exactly one wire attempt and the exact updated_at returned by sending_settings_get. Empty expected_updated_at asserts first write. This tool has no fallback route and never automatically repeats an ambiguous write. max_sends_per_hour caps dispatch from the send worker; null removes only the workspace-specific ceiling. Quiet-hour fields must all be HH:MM/IANA values or all be empty strings. Any response without exact HTTP >=400 not-committed proof, including a redirect, unproven 4xx/5xx, invalid 2xx, or transport failure, requires reconciliation: wait at least 35 seconds from submission, then call sending_settings_get with include_coordination_status=true; do not repeat this tool until canonical settings and ready matching cap status prove the outcome.",
      schema: z
        .object({
          max_sends_per_hour: z.number().int().min(1).max(1_000_000).nullable(),
          quiet_hours_start: HHMMOrEmpty,
          quiet_hours_end: HHMMOrEmpty,
          quiet_hours_tz: PortableTimeZoneOrEmpty,
          quiet_hours_per_recipient: z.boolean(),
          expected_updated_at: z.string().max(64),
        })
        .strict()
        .superRefine((value, context) => {
          const cleared =
            value.quiet_hours_start === "" &&
            value.quiet_hours_end === "" &&
            value.quiet_hours_tz === "";
          const configured =
            value.quiet_hours_start !== "" &&
            value.quiet_hours_end !== "" &&
            value.quiet_hours_tz !== "";
          if (!cleared && !configured) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "quiet-hours start, end, and timezone must all be set or all be empty",
              path: ["quiet_hours_start"],
            });
          } else if (
            configured &&
            value.quiet_hours_start === value.quiet_hours_end
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "quiet-hours start and end must differ",
              path: ["quiet_hours_end"],
            });
          }
        }),
      annotations: { destructiveHint: true, idempotentHint: false },
      requiredScopes: ["admin"],
      handler: async (input) => {
        try {
          return await client.sendingSettings.set(input);
        } catch (err) {
          if (isOutcomeAmbiguous(err)) {
            throw ambiguousOutcomeErr(err);
          }
          if (isConfirmedNotCommitted(err)) {
            throw confirmedNotCommittedErr(err);
          }
          throw wrapErr("sending_settings_set", err);
        }
      },
    },
  ];
}

function isPortableTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

type SendingCapOutcome =
  | "not-committed"
  | "committed"
  | "committed-conservatively-fenced"
  | "commit-outcome-unknown-conservatively-fenced";

interface SendingControlError extends Error {
  status: number;
  responseMetadata?: { sendingCapOutcome?: SendingCapOutcome };
}

function isSendingControlError(err: unknown): err is SendingControlError {
  return (
    err instanceof Error &&
    typeof (err as { status?: unknown }).status === "number"
  );
}

function isOutcomeAmbiguous(err: unknown): err is SendingControlError {
  if (!isSendingControlError(err)) return false;
  // Only an exact receipt actually received on HTTP >=400 proves that another
  // compare-and-set attempt is safe. Upstream, pre-handler, panic, or proxy
  // responses may omit or rewrite it and remain outcome-ambiguous.
  return !isConfirmedNotCommitted(err);
}

function isConfirmedNotCommitted(err: unknown): err is SendingControlError {
  return (
    isSendingControlError(err) &&
    err.status >= 400 &&
    err.responseMetadata?.sendingCapOutcome === "not-committed"
  );
}

function ambiguousOutcomeErr(err: SendingControlError): Error {
  const outcome =
    err.responseMetadata?.sendingCapOutcome ?? "missing-or-invalid";
  return new Error(
    "sending_settings_set: one wire attempt was made and was not retried; the response outcome is " +
      outcome +
      ". Wait at least 35 seconds from submission, then call sending_settings_get with include_coordination_status=true; do not call sending_settings_set again until canonical settings plus cap_coordination_ready=true and cap_coordination_matches_settings=true prove the outcome. Original error: " +
      err.message,
  );
}

function confirmedNotCommittedErr(err: SendingControlError): Error {
  return new Error(
    "sending_settings_set: one wire attempt was made and was not retried; the server confirmed not-committed on an HTTP failure. Refresh sending_settings_get with include_coordination_status=true before issuing a new compare-and-set write. Original error: " +
      err.message,
  );
}

function wrapErr(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
