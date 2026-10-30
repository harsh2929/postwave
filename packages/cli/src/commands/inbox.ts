// SPDX-License-Identifier: MIT

import { createClient } from "../lib/client.js";
import { readStdinLimited, readTextFileLimited } from "../lib/input.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";

export interface InboxOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  campaignId?: string;
  domain?: string;
  file?: string;
  subject?: string;
  output?: OutputFormat;
}

export async function inboxReport(opts: InboxOpts = {}): Promise<void> {
  if (!opts.campaignId) {
    console.error("Pass --campaign-id <id>");
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);
  const r = await client.inboxReality.getCampaignReport(opts.campaignId);
  console.log(formatOutput(r, opts.output ?? "json"));
}

export async function inboxPredict(opts: InboxOpts = {}): Promise<void> {
  const client = createClient(opts);
  let html: string;
  try {
    html = await readHtml(opts);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  const subject = opts.subject ?? "(no subject)";
  const r = await client.inboxReality.predict({ html, subject });
  console.log(formatOutput(r, opts.output ?? "json"));
}

export async function inboxReputation(opts: InboxOpts = {}): Promise<void> {
  const client = createClient(opts);
  const r = await client.reputation.get();
  console.log(formatOutput(r, opts.output ?? "json"));
}

export async function inboxAuth(opts: InboxOpts = {}): Promise<void> {
  const client = createClient(opts);
  const r = await client.authChecks.list();
  console.log(formatOutput(r, opts.output ?? "table"));
}

async function readHtml(opts: InboxOpts): Promise<string> {
  if (opts.file) return readTextFileLimited(opts.file);
  return await readStdinLimited();
}
