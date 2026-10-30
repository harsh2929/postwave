#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import cac from "cac";
import chalk from "chalk";
import prompts from "prompts";
import {
  MCP_RELEASE_HOLD_CODE,
  MCP_RELEASE_HOLD_MESSAGE,
} from "./release-status.js";

const SKILL_NAMES = [
  "postwave-email",
  "postwave-diagnose",
  "postwave-migrate",
  "postwave-preview",
  "postwave-sequence",
  "postwave-deliverability-audit",
  "postwave-voice-tune",
];

const cli = cac("postwave-cc-install");

cli
  .command("[scope]", "Report the Moosewave Claude package release status")
  .option("--uninstall", "Remove postwave-* skills instead of installing")
  .option("--yes", "Skip confirmation prompts")
  .action(async (scope: string | undefined, opts: { uninstall?: boolean; yes?: boolean }) => {
    if (opts.uninstall) {
      await uninstall(scope, opts.yes ?? false);
      return;
    }
    install();
  });

cli.help();
cli.version("0.1.0");
cli.parse();

function install() {
  console.error(chalk.yellow(MCP_RELEASE_HOLD_CODE));
  console.error(MCP_RELEASE_HOLD_MESSAGE);
  process.exitCode = 1;
}

async function uninstall(initialScope: string | undefined, yes: boolean) {
  let scope = initialScope;
  if (!scope) {
    const r = await prompts({
      type: "select",
      name: "scope",
      message: "Uninstall from which scope?",
      choices: [
        { title: "This project", value: "project" },
        { title: "Personal", value: "personal" },
      ],
      initial: 0,
    });
    scope = r.scope as string | undefined;
    if (!scope) return;
  }

  const target = resolveTarget(scope);

  if (!yes) {
    const r = await prompts({
      type: "confirm",
      name: "ok",
      message: `Remove postwave-* skills from ${target}?`,
      initial: false,
    });
    if (!r.ok) return;
  }

  for (const name of SKILL_NAMES) {
    const dst = join(target, name);
    if (existsSync(dst)) {
      rmSync(dst, { recursive: true, force: true });
      console.log(chalk.green(`  removed ${name}`));
    }
  }

  console.log("");
  console.log("To remove the CLAUDE.md block manually, search for");
  console.log(chalk.cyan("  <!-- postwave:start --> ... <!-- postwave:end -->"));
  console.log("and delete that section.");
}

function resolveTarget(scope: string): string {
  if (scope === "personal") {
    return join(homedir(), ".claude", "skills");
  }
  return join(process.cwd(), ".claude", "skills");
}
