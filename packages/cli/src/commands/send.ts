// SPDX-License-Identifier: MIT
//
// `pw send` — one-off test send (transactional) and `pw broadcast` —
// dispatch an existing draft campaign.
//
// `pw send` is the small "send me a quick test" surface customers reach
// for during template work — equivalent to clicking "Send test" in the
// dashboard but scriptable. `pw broadcast` is the production handoff:
// it walks the draft → sending lifecycle the same way the dashboard's
// "Send now" button does.

import { createClient } from "../lib/client.js";
import { readTextFileLimited } from "../lib/input.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";

export interface SendOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  output?: OutputFormat;
  campaignId?: string;
  to?: string;
  subject?: string;
  bodyHtml?: string;
  bodyMjml?: string;
  file?: string;
}

export async function sendCommand(opts: SendOpts = {}): Promise<void> {
  if (!opts.to) {
    console.error("--to <email> is required");
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);

  // Body can come from --body-html, --body-mjml, or --file (which is
  // treated as HTML unless the filename ends in .mjml).
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
  if (!bodyHtml && !bodyMjml && !opts.campaignId) {
    console.error("provide --campaign-id, --file, --body-html, or --body-mjml");
    process.exitCode = 1;
    return;
  }

  let out;
  if (opts.campaignId) {
    out = await client.campaigns.sendTest({
      campaignId: opts.campaignId,
      toEmail: opts.to,
      subject: opts.subject,
      bodyHtml,
      bodyMjml,
    });
  } else {
    if (!opts.subject || !bodyHtml) {
      console.error("--subject and HTML body required when --campaign-id is not set");
      process.exitCode = 1;
      return;
    }
    out = await client.campaigns.sendTest({
      toEmail: opts.to,
      subject: opts.subject,
      bodyHtml,
      bodyMjml,
    });
  }
  console.log(formatOutput(out, opts.output ?? "table"));
}

export interface BroadcastOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  output?: OutputFormat;
  campaignId?: string;
  /** Confirm prompt bypass; required for non-interactive use. */
  yes?: boolean;
  /** Dry-run flag — server-side simulation only. */
  sandbox?: boolean;
}

export async function broadcastCommand(opts: BroadcastOpts = {}): Promise<void> {
  if (!opts.campaignId) {
    console.error("--campaign-id <id> is required");
    process.exitCode = 1;
    return;
  }
  if (!opts.yes && !opts.sandbox) {
    console.error(
      "this will dispatch the campaign to its full audience. Pass --yes to confirm or --sandbox to simulate.",
    );
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);
  const out = await client.campaigns.send(opts.campaignId, {
    sandbox: opts.sandbox === true,
  });
  console.log(formatOutput(out, opts.output ?? "table"));
}
