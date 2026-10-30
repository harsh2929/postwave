// SPDX-License-Identifier: MIT

import open from "open";
import chalk from "chalk";
import { createClient } from "../lib/client.js";
import { getCredentials } from "../lib/config.js";
import { startDevServer } from "../dev/server.js";

export interface DevOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  port?: number | string;
  browser?: boolean;
}

export async function devCommand(opts: DevOpts = {}): Promise<void> {
  const client = createClient(opts);
  const port = Number(
    opts.port ?? process.env.POSTWAVE_DEV_PORT ?? 4321,
  );
  if (!Number.isFinite(port) || port <= 0) {
    console.error(chalk.red(`Invalid port: ${opts.port}`));
    process.exitCode = 1;
    return;
  }
  const recipient = getCredentials()?.email ?? "preview@postwave.local";

  const handle = await startDevServer({
    client,
    port,
    cwd: process.cwd(),
    recipientEmail: recipient,
  });

  console.log(chalk.cyan(`\n  Moosewave dev server: ${handle.url}`));
  console.log(chalk.gray(`  Watching *.email.tsx and *.mjml in ${process.cwd()}`));
  console.log(chalk.gray(`  Test recipient: ${recipient}\n`));

  const wantBrowser = opts.browser !== false;
  if (wantBrowser) {
    try {
      await open(handle.url);
    } catch {
      /* ignore — user can open manually */
    }
  }

  const stop = async () => {
    console.log(chalk.gray("\n  shutting down..."));
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}
