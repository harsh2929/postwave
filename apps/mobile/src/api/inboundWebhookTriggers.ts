/**
 * api/inboundWebhookTriggers.ts — the trigger RULES of one inbound endpoint.
 *
 * An endpoint's rules are what turn "an event arrived" into "a subscriber was
 * enrolled / tagged / put into an automation". When an upstream system floods
 * or a rule misfires, the on-call verb is "pause that rule" — and until now
 * the phone could see events flow but not the rules acting on them.
 *
 * Every route below was read in apps/api/internal/inbound_webhooks/handlers.go
 * (mounted at :166-169 behind the admin chain; manifest role=admin, all four):
 *
 *   GET    /api/v1/inbound-webhooks/{id}/triggers          → {items: Trigger[]}
 *   POST   /api/v1/inbound-webhooks/{id}/triggers          → 201 Trigger
 *   PATCH  /api/v1/inbound-webhooks/{id}/triggers/{tid}    → 200 Trigger
 *   DELETE /api/v1/inbound-webhooks/{id}/triggers/{tid}    → {ok: true}
 *
 * Shapes and limits live in lib/inboundTriggerRules.ts (pure, unit-tested);
 * this module is only the transport. None of it is queued for offline replay:
 * a rule resumed from a queue hours later acts on events nobody reviewed.
 */
import {
  parseTriggerRuleList,
  normalizeTriggerRule,
  type InboundTriggerRule,
  type TriggerRuleInput,
} from "@/lib/inboundTriggerRules";
import { WireShapeError } from "@/lib/wireShapeError";

import { InboundWebhookError } from "./inboundWebhooks";
import { rawRequest } from "./request";

/** PATCH accepts any subset; `active` alone is the pause/resume lever. */
export type TriggerRulePatch = Partial<TriggerRuleInput> & { active?: boolean };

async function call<T>(
  method: string,
  path: string,
  label: string,
  body?: unknown,
): Promise<T> {
  const res = await rawRequest<T>(method, path, body);
  if (res.error) throw new InboundWebhookError(res.error, label);
  if (res.data == null) throw new Error(`${label} returned no data.`);
  return res.data;
}

function triggersPath(endpointId: string, triggerId?: string): string {
  const base = `/api/v1/inbound-webhooks/${encodeURIComponent(endpointId)}/triggers`;
  return triggerId ? `${base}/${encodeURIComponent(triggerId)}` : base;
}

/** A saved row the server did not echo back is a bug worth surfacing, not hiding. */
function savedRule(payload: unknown, label: string): InboundTriggerRule {
  const rule = normalizeTriggerRule(payload);
  if (!rule) {
    throw new WireShapeError(
      "trigger rule",
      `${label} returned an unreadable rule.`,
    );
  }
  return rule;
}

export async function listInboundTriggerRules(
  endpointId: string,
): Promise<InboundTriggerRule[]> {
  const res = await call<unknown>(
    "GET",
    triggersPath(endpointId),
    "Loading trigger rules",
  );
  return parseTriggerRuleList(res);
}

export async function createInboundTriggerRule(
  endpointId: string,
  input: TriggerRuleInput,
): Promise<InboundTriggerRule> {
  const res = await call<unknown>(
    "POST",
    triggersPath(endpointId),
    "Creating the trigger rule",
    input,
  );
  return savedRule(res, "Creating the trigger rule");
}

export async function updateInboundTriggerRule(
  endpointId: string,
  triggerId: string,
  patch: TriggerRulePatch,
): Promise<InboundTriggerRule> {
  const res = await call<unknown>(
    "PATCH",
    triggersPath(endpointId, triggerId),
    "Updating the trigger rule",
    patch,
  );
  return savedRule(res, "Updating the trigger rule");
}

export async function deleteInboundTriggerRule(
  endpointId: string,
  triggerId: string,
): Promise<void> {
  await call<unknown>(
    "DELETE",
    triggersPath(endpointId, triggerId),
    "Deleting the trigger rule",
  );
}
