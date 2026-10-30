// SPDX-License-Identifier: MIT

import chalk from "chalk";
import { createClient } from "../lib/client.js";

export interface AutomationOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  automationId?: string;
  email?: string;
}

export async function automationTrigger(opts: AutomationOpts = {}): Promise<void> {
  if (!opts.automationId || !opts.email) {
    console.error("Pass --automation-id <id> and --email <address>");
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);
  await client.automations.trigger({
    automation_id: opts.automationId,
    trigger_type: "manual",
    subscriber_email: opts.email,
  });
  console.log(chalk.green("Triggered."));
}

export async function automationPause(opts: AutomationOpts = {}): Promise<void> {
  if (!opts.automationId) {
    console.error("Pass --automation-id <id>");
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);
  await client.automations.pause(opts.automationId);
  console.log(chalk.yellow("Paused."));
}

export async function automationResume(opts: AutomationOpts = {}): Promise<void> {
  if (!opts.automationId) {
    console.error("Pass --automation-id <id>");
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);
  await client.automations.resume(opts.automationId);
  console.log(chalk.green("Resumed."));
}
