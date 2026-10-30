// SPDX-License-Identifier: MIT
//
// `pw warmup status` — show today's warmup cap, day-in-curve, and
// engagement multiplier. Replaces the dashboard's "Warmup" widget for
// terminal-native operators.

import { createClient } from "../lib/client.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";

export interface WarmupOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  output?: OutputFormat;
}

export async function warmupStatusCommand(opts: WarmupOpts = {}): Promise<void> {
  const client = createClient(opts);
  // Sending resource: GET /api/v1/sending/warmup returns:
  //   { started_at, day, tier_limit, today_cap, schedule:[{day, cap}, ...] }
  // and (when the engagement modifier is wired) an extra `modifier`
  // field reflecting the current 7d engagement multiplier.
  const out = await client.sending.getWarmup();
  console.log(formatOutput(out, opts.output ?? "table"));
}
