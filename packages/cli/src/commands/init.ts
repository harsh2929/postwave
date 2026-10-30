// SPDX-License-Identifier: MIT

import chalk from "chalk";
import prompts from "prompts";
import { createClient } from "../lib/client.js";

export async function initCommand(opts: { apiKey?: string; baseUrl?: string; tenantId?: string } = {}): Promise<void> {
  console.log(chalk.bold("Moosewave init wizard"));
  const answers = await prompts([
    { type: "text", name: "domain", message: "Sending domain (e.g. mail.example.com):" },
    { type: "text", name: "fromName", message: "Default From name:" },
    { type: "text", name: "fromEmail", message: "Default From address:" },
  ]);
  if (!answers.domain || !answers.fromEmail) {
    console.log("Aborted.");
    return;
  }

  const client = createClient(opts);
  try {
    await client.request("PATCH", "/api/v1/me", {
      body: {
        sending_domain: answers.domain,
        from_name: answers.fromName,
        from_email: answers.fromEmail,
      },
    });
  } catch (err) {
    console.warn(chalk.yellow(`Could not save defaults: ${(err as Error).message}`));
  }

  console.log(chalk.bold("\nDNS records to set on " + answers.domain + ":"));
  console.log("  TXT  @          \"v=spf1 include:_spf.moosewave.com ~all\"");
  console.log("  TXT  postwave._domainkey   \"<copy from dashboard>\"");
  console.log("  TXT  _dmarc      \"v=DMARC1; p=none; rua=mailto:dmarc@" + answers.domain + "\"");
  console.log(chalk.dim("\nWhen DNS has propagated, run: postwave inbox auth"));
}
