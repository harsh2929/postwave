// SPDX-License-Identifier: MIT
//
// `pw campaigns ...` — write-side parity for the campaign lifecycle.
// create / update build drafts; queue and send walk the production
// dispatch path (queue = compliance + approval + suppression gating;
// send = the immediate Listmonk handoff). delete removes a draft.
//
// Both dispatch paths are gated behind --yes (or --sandbox) the same way
// `pw broadcast` is, since they fan out to a real audience.

import chalk from "chalk";
import type {
  Campaign,
  CampaignQueueResponse,
  CreateCampaignInput,
  UpdateCampaignInput,
} from "@postwave/sdk";
import { createClient, type ClientOpts } from "../lib/client.js";
import { readTextFileLimited } from "../lib/input.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";

export interface CampaignsWriteOpts extends ClientOpts {
  name?: string;
  subject?: string;
  bodyHtml?: string;
  bodyMjml?: string;
  file?: string;
  segmentId?: string;
  // CAC delivers an explicit `--scheduled-at ""` (or `--scheduled-at " "`) as the
  // number 0 rather than an empty string, so the runtime type is widened here to
  // let the patch builder distinguish "absent" (undefined) from "clear" (empty).
  scheduledAt?: string | number;
  yes?: boolean;
  sandbox?: boolean;
  output?: OutputFormat;
}

export async function campaignsCreate(opts: CampaignsWriteOpts = {}): Promise<void> {
  let input: CreateCampaignInput;
  try {
    input = campaignCreateInputFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }
  const client = createClient(opts);
  const out = await client.campaigns.create(input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function campaignsUpdate(
  id: string | undefined,
  opts: CampaignsWriteOpts = {},
): Promise<void> {
  const campaignId = requireId(id);
  if (!campaignId) return;
  let patch: UpdateCampaignInput;
  try {
    patch = campaignPatchFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }
  const client = createClient(opts);
  const out = await client.campaigns.update(campaignId, patch);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function campaignsQueue(
  id: string | undefined,
  opts: CampaignsWriteOpts = {},
): Promise<void> {
  const campaignId = requireId(id);
  if (!campaignId) return;
  if (!confirmDispatch(opts)) return;
  const client = createClient(opts);
  const out = await client.campaigns.queue(campaignId, {
    sandbox: opts.sandbox === true,
  });
  console.log(formatOutput(out, opts.output ?? "json"));
  reportDispatchOutcome(out, "queue");
}

export async function campaignsSend(
  id: string | undefined,
  opts: CampaignsWriteOpts = {},
): Promise<void> {
  const campaignId = requireId(id);
  if (!campaignId) return;
  if (!confirmDispatch(opts)) return;
  const client = createClient(opts);
  const out = await client.campaigns.send(campaignId, {
    sandbox: opts.sandbox === true,
  });
  console.log(formatOutput(out, opts.output ?? "json"));
  reportDispatchOutcome(out, "send");
}

export async function campaignsDelete(
  id: string | undefined,
  opts: CampaignsWriteOpts = {},
): Promise<void> {
  const campaignId = requireId(id);
  if (!campaignId) return;
  if (!opts.yes) {
    console.error("This permanently deletes the campaign. Pass --yes to confirm.");
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);
  await client.campaigns.delete(campaignId);
  console.log(chalk.green(`Deleted campaign ${campaignId}.`));
}

export function campaignCreateInputFromOptions(
  opts: CampaignsWriteOpts,
): CreateCampaignInput {
  const name = (opts.name ?? "").trim();
  if (!name) throw new Error("Pass --name <name> to create a campaign.");
  const subject = (opts.subject ?? "").trim();
  if (!subject) throw new Error("Pass --subject <text> to create a campaign.");
  const input: CreateCampaignInput = { name, subject };
  const body = resolveBody(opts);
  if (body.bodyHtml) input.body_html = body.bodyHtml;
  if (body.bodyMjml) input.body_mjml = body.bodyMjml;
  const segmentId = (opts.segmentId ?? "").trim();
  if (segmentId) input.segment_id = segmentId;
  // On create there is nothing to unschedule, so an empty value is simply ignored.
  const scheduledAt = normalizeScheduledAt(opts.scheduledAt);
  if (typeof scheduledAt === "string") input.scheduled_at = scheduledAt;
  return input;
}

export function campaignPatchFromOptions(opts: CampaignsWriteOpts): UpdateCampaignInput {
  const patch: UpdateCampaignInput = {};
  const name = (opts.name ?? "").trim();
  if (name) patch.name = name;
  const subject = (opts.subject ?? "").trim();
  if (subject) patch.subject = subject;
  const body = resolveBody(opts);
  if (body.bodyHtml) patch.body_html = body.bodyHtml;
  if (body.bodyMjml) patch.body_mjml = body.bodyMjml;
  const segmentId = (opts.segmentId ?? "").trim();
  if (segmentId) patch.segment_id = segmentId;
  // `undefined` -> flag absent, leave untouched. `null` -> explicit clear
  // (`--scheduled-at ""`), unschedule the campaign. string -> set the schedule.
  const scheduledAt = normalizeScheduledAt(opts.scheduledAt);
  if (scheduledAt !== undefined) patch.scheduled_at = scheduledAt;
  if (Object.keys(patch).length === 0) {
    throw new Error(
      "Pass at least one of --name, --subject, --body-html, --body-mjml, --file, --segment-id, or --scheduled-at to update.",
    );
  }
  return patch;
}

/**
 * Normalize the `--scheduled-at` value into one of three intents:
 *   undefined -> flag was not passed (caller should leave the field untouched)
 *   null      -> explicit clear (`--scheduled-at ""`) -> unschedule
 *   string    -> a concrete ISO-8601 timestamp to set
 *
 * CAC surfaces an explicit empty value as the number 0 (not ""), so this also
 * normalizes the numeric form into the clear intent instead of crashing on
 * `0.trim()`.
 */
function normalizeScheduledAt(value: string | number | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  // CAC encodes an explicit empty value (`--scheduled-at ""`) as the number 0.
  if (typeof value === "number") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function resolveBody(opts: CampaignsWriteOpts): {
  bodyHtml?: string;
  bodyMjml?: string;
} {
  let bodyHtml = opts.bodyHtml;
  let bodyMjml = opts.bodyMjml;
  if (opts.file) {
    const content = readTextFileLimited(opts.file);
    if (opts.file.toLowerCase().endsWith(".mjml")) {
      bodyMjml = content;
    } else {
      bodyHtml = content;
    }
  }
  return { bodyHtml, bodyMjml };
}

/**
 * The production dispatch path can accept a campaign for queueing *or* return an
 * approval-required response (the campaign was gated, not dispatched). The HTTP
 * call still resolves 200 in that case, so without this check the CLI would exit
 * 0 and a script would treat the gated campaign as "sent". Detect the blocked
 * response and set a non-zero exit code with a clear message.
 */
function reportDispatchOutcome(
  out: Campaign | CampaignQueueResponse,
  verb: "queue" | "send",
): void {
  if (!isBlockedDispatch(out)) return;
  const reason =
    out.message ??
    `Campaign ${out.campaign_id} was not dispatched: approval required` +
      (out.approval_status ? ` (approval ${out.approval_status})` : "") +
      ".";
  console.error(
    chalk.yellow(
      `${verb === "queue" ? "Queue" : "Send"} blocked — ${reason} ` +
        "The campaign was NOT dispatched.",
    ),
  );
  process.exitCode = 1;
}

function isBlockedDispatch(
  out: Campaign | CampaignQueueResponse,
): out is CampaignQueueResponse {
  // `send` may return a plain Campaign (no campaign_id field) when it succeeds;
  // a queue/approval response always carries campaign_id + an approval signal.
  if (!out || typeof out !== "object") return false;
  if (!("campaign_id" in out)) return false;
  const queued = out as CampaignQueueResponse;
  if (queued.status === "approval_required") return true;
  // Defensive: some backends report the gate via approval_status instead of
  // overloading the lifecycle status. Treat any non-approved approval as blocked.
  const approval = queued.approval_status?.toLowerCase();
  if (approval && approval !== "approved" && approval !== "auto_approved") {
    return true;
  }
  return false;
}

function confirmDispatch(opts: CampaignsWriteOpts): boolean {
  if (opts.yes || opts.sandbox) return true;
  console.error(
    "This dispatches the campaign to its full audience. Pass --yes to confirm or --sandbox to simulate.",
  );
  process.exitCode = 1;
  return false;
}

function requireId(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    console.error("Pass a campaign id.");
    process.exitCode = 1;
    return null;
  }
  return trimmed;
}

function printCommandError(err: unknown): void {
  console.error(chalk.red((err as Error).message));
  process.exitCode = 1;
}
