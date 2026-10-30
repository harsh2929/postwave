// SPDX-License-Identifier: MIT

import chalk from "chalk";
import { createClient } from "../lib/client.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";
import type { MeResponse } from "@postwave/sdk";

export interface WhoamiOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  output?: OutputFormat;
}

export async function whoami(opts: WhoamiOpts = {}): Promise<void> {
  try {
    const client = createClient(opts);
    const me = await client.request<MeResponse>("GET", "/api/v1/me");
    if (opts.output && opts.output !== "table") {
      console.log(formatOutput(me, opts.output));
      return;
    }
    console.log(`${chalk.bold("tenant:")} ${me.tenant ?? "(unknown)"}`);
    console.log(`${chalk.bold("user:  ")} ${me.user ?? "(unknown)"}`);
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exitCode = 1;
  }
}
