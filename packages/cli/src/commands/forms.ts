// SPDX-License-Identifier: MIT

import { createClient } from "../lib/client.js";
import { parseJsonObject, readTextFileLimited } from "../lib/input.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";

export interface FormsOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  spec?: string;
  output?: OutputFormat;
}

export async function formsList(opts: FormsOpts = {}): Promise<void> {
  const client = createClient(opts);
  const out = await client.forms.list();
  console.log(formatOutput(out, opts.output ?? "table"));
}

export async function formsCreate(opts: FormsOpts = {}): Promise<void> {
  if (!opts.spec) {
    console.error("Pass --spec <path-to-json>");
    process.exitCode = 1;
    return;
  }
  let json: Record<string, unknown>;
  try {
    json = parseJsonObject(readTextFileLimited(opts.spec), "form spec");
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);
  const created = await client.forms.create(json as never);
  console.log(formatOutput(created, opts.output ?? "json"));
}
