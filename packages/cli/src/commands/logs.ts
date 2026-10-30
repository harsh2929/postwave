// SPDX-License-Identifier: MIT

import chalk from "chalk";
import { createClient } from "../lib/client.js";
import type { EventRecord, StreamParams } from "@postwave/sdk";

export interface LogsTailOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  filter?: string | string[];
}

export async function logsTailCommand(opts: LogsTailOpts = {}): Promise<void> {
  const client = createClient(opts);
  const filters = parseFilters(opts.filter);

  const ac = new AbortController();
  process.on("SIGINT", () => {
    console.log(chalk.gray("\n  stopped."));
    ac.abort();
    process.exit(0);
  });

  const params: StreamParams = { signal: ac.signal };
  if (filters.event_type) params.event_type = filters.event_type;
  if (filters.campaign) params.campaign = filters.campaign;

  console.log(
    chalk.cyan("Streaming events ") +
      chalk.gray(filters.event_type || filters.campaign ? `(${formatFilters(filters)})` : "(no filter)") +
      chalk.gray(" — Ctrl-C to stop\n"),
  );

  try {
    for await (const evt of client.events.stream(params)) {
      if (!matchesFilters(evt, filters)) continue;
      printEvent(evt);
    }
  } catch (err) {
    if (ac.signal.aborted) return;
    console.error(chalk.red(`stream error: ${(err as Error).message}`));
    process.exitCode = 1;
  }
}

interface ParsedFilters {
  event_type?: string;
  campaign?: string;
  extra: Record<string, string>;
}

export function parseFilters(raw: string | string[] | undefined): ParsedFilters {
  const out: ParsedFilters = { extra: {} };
  if (!raw) return out;
  const arr = Array.isArray(raw) ? raw : [raw];
  for (const item of arr) {
    const eq = item.indexOf("=");
    if (eq === -1) continue;
    const k = item.slice(0, eq).trim();
    const v = item.slice(eq + 1).trim();
    if (k === "event_type") out.event_type = v;
    else if (k === "campaign" || k === "campaign_id") out.campaign = v;
    else out.extra[k] = v;
  }
  return out;
}

function matchesFilters(e: EventRecord, f: ParsedFilters): boolean {
  if (f.event_type && e.event_type !== f.event_type) return false;
  if (f.campaign && e.campaign_id !== f.campaign) return false;
  for (const [k, v] of Object.entries(f.extra)) {
    const actual = (e as unknown as Record<string, unknown>)[k];
    if (String(actual ?? "") !== v) return false;
  }
  return true;
}

function formatFilters(f: ParsedFilters): string {
  const parts: string[] = [];
  if (f.event_type) parts.push(`event_type=${f.event_type}`);
  if (f.campaign) parts.push(`campaign=${f.campaign}`);
  for (const [k, v] of Object.entries(f.extra)) parts.push(`${k}=${v}`);
  return parts.join(" ");
}

export function printEvent(e: EventRecord): void {
  const ts = chalk.gray(`[${e.ts}]`);
  const type = chalk.cyan(e.event_type.padEnd(12));
  const who = chalk.white(e.subscriber_email ?? "-");
  const camp = e.campaign_id ? chalk.gray(`campaign=${e.campaign_id}`) : "";
  console.log(`${ts} ${type} ${who} ${camp}`.trim());
}
