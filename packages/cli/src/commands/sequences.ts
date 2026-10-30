// SPDX-License-Identifier: MIT

import chalk from "chalk";
import { isSequenceJobAck } from "@postwave/sdk";

import { createClient } from "../lib/client.js";
import { spinner } from "../lib/spinner.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";
import { parseJsonObject } from "../lib/input.js";

export interface SequencesOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  templateId?: string;
  variables?: string;
  hint?: string;
  output?: OutputFormat;
}

export async function sequencesList(opts: SequencesOpts = {}): Promise<void> {
  const client = createClient(opts);
  const list = await client.sequences.list();
  console.log(formatOutput(list, opts.output ?? "table"));
}

export async function sequencesGenerate(opts: SequencesOpts = {}): Promise<void> {
  if (!opts.templateId) {
    console.error("Pass --template-id <slug>");
    process.exitCode = 1;
    return;
  }
  const vars = parseVariables(opts.variables);
  if (!vars) return;
  const client = createClient(opts);
  const s = spinner("Generating sequence…").start();
  try {
    const seq = await client.sequences.generate({
      template_id: opts.templateId,
      name: opts.templateId,
      variables: vars,
    });
    s.succeed(
      isSequenceJobAck(seq)
        ? `Sequence generation job ${seq.job_id} queued.`
        : `Sequence ${seq.id} created.`,
    );
    console.log(formatOutput(seq, opts.output ?? "json"));
  } catch (err) {
    s.fail((err as Error).message);
    process.exitCode = 1;
  }
}

export async function sequencesRegenerate(
  sequenceId: string,
  position: number,
  opts: SequencesOpts = {},
): Promise<void> {
  const client = createClient(opts);
  if (!Number.isSafeInteger(position) || position < 1) {
    console.error(chalk.red("Sequence email position must be a positive integer."));
    process.exitCode = 1;
    return;
  }
  const s = spinner(`Regenerating email ${position}…`).start();
  try {
    const out = await client.sequences.regenerate(sequenceId, position, {
      user_hint: opts.hint,
    });
    s.succeed("Done.");
    console.log(formatOutput(out, opts.output ?? "json"));
  } catch (err) {
    s.fail((err as Error).message);
    process.exitCode = 1;
  }
}

function parseVariables(input: string | undefined): Record<string, string> | null {
  if (!input) return {};
  try {
    const parsed = parseJsonObject(input, "sequence variables", {
      maxBytes: 64 * 1024,
      maxDepth: 8,
      maxKeys: 100,
      maxStringChars: 8 * 1024,
    });
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, String(value)]),
    );
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exitCode = 1;
    return null;
  }
}
