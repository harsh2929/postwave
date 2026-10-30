// SPDX-License-Identifier: MIT

import chalk from "chalk";
import prompts from "prompts";
import { createClient } from "../lib/client.js";
import { parseJsonObject, readStdinLimited } from "../lib/input.js";
import type { SegmentNode } from "@postwave/sdk";
import { formatOutput, type OutputFormat } from "../lib/output.js";

export interface SegmentsFromTextOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  query?: string;
  name?: string;
  yes?: boolean;
  output?: OutputFormat;
}

export async function segmentsFromText(opts: SegmentsFromTextOpts = {}): Promise<void> {
  const client = createClient(opts);
  let stdin = "";
  try {
    stdin = opts.query ? "" : await readStdinLimited();
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exitCode = 1;
    return;
  }
  const text = (opts.query ?? stdin).trim();
  if (!text) {
    console.error(chalk.red("No query supplied. Pass --query <text> or pipe text on stdin."));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.gray("Compiling: ") + chalk.white(text));
  const compiled = await client.segments.compileFromNaturalLanguage(text);

  console.log(chalk.cyan("\nCompiled AST:"));
  console.log(highlightJson(compiled.query_ast));

  const name = opts.name ?? compiled.suggested_name ?? autoName(text);

  let confirmed = opts.yes === true;
  if (!confirmed) {
    const ans = await prompts({
      type: "confirm",
      name: "ok",
      message: `Save as segment "${name}"?`,
      initial: true,
    });
    confirmed = ans.ok === true;
  }
  if (!confirmed) {
    console.log(chalk.yellow("Aborted."));
    return;
  }

  const created = await client.segments.create({ name, query_ast: compiled.query_ast });
  console.log(chalk.green(`Created segment ${created.id} (${created.name}).`));
  console.log(formatOutput(created, opts.output ?? "json"));
}

export interface SegmentsCreateOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  name?: string;
  ast?: string;
  output?: OutputFormat;
}

export async function segmentsCreate(opts: SegmentsCreateOpts = {}): Promise<void> {
  const client = createClient(opts);
  if (!opts.name) {
    console.error(chalk.red("Pass --name <name>"));
    process.exitCode = 1;
    return;
  }
  let astText: string;
  try {
    astText = opts.ast ?? (await readStdinLimited());
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exitCode = 1;
    return;
  }
  let ast: SegmentNode;
  try {
    ast = parseJsonObject(astText, "segment AST") as SegmentNode;
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exitCode = 1;
    return;
  }
  const created = await client.segments.create({ name: opts.name, query_ast: ast });
  console.log(formatOutput(created, opts.output ?? "json"));
}

export function autoName(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `segment-${Date.now()}`;
}

export function highlightJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  return json
    .replace(/(".*?")(\s*:)/g, (_m, key: string, colon: string) => chalk.cyan(key) + colon)
    .replace(/:\s(".*?")/g, (_m, val: string) => ": " + chalk.green(val))
    .replace(/:\s(true|false|null)/g, (_m, val: string) => ": " + chalk.yellow(val))
    .replace(/:\s(-?\d+(?:\.\d+)?)/g, (_m, val: string) => ": " + chalk.magenta(val));
}
