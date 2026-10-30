// SPDX-License-Identifier: MIT

import chalk from "chalk";
import { createClient } from "../lib/client.js";
import { spinner } from "../lib/spinner.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";

export interface DiagnoseOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  output?: OutputFormat;
}

export async function diagnoseCommand(campaignId: string, opts: DiagnoseOpts = {}): Promise<void> {
  const client = createClient(opts);
  const s = spinner(`Diagnosing campaign ${campaignId}…`).start();
  try {
    const d = await client.inboxReality.diagnose(campaignId);
    s.succeed("Done.");
    if (opts.output && opts.output !== "table") {
      console.log(formatOutput(d, opts.output));
      return;
    }
    console.log(chalk.bold("\nDiagnosis"));
    console.log(d.diagnosis ?? "(no diagnosis text)");
    if (Array.isArray(d.fixes) && d.fixes.length > 0) {
      console.log(chalk.bold("\nFixes"));
      d.fixes.forEach((f, i) => {
        const impact = typeof f.estimated_impact === "number" ? ` (+${(f.estimated_impact * 100).toFixed(0)}%)` : "";
        console.log(`  ${i + 1}. ${chalk.cyan(f.title ?? "")}${impact}`);
        if (f.detail) console.log(`     ${f.detail}`);
      });
    }
  } catch (err) {
    s.fail((err as Error).message);
    process.exitCode = 1;
  }
}
