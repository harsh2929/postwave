// SPDX-License-Identifier: MIT

import { createClient } from "../lib/client.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";
import type { TemplateCategory } from "@postwave/sdk";

export interface TemplatesOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  category?: string;
  output?: OutputFormat;
}

export async function templatesList(opts: TemplatesOpts = {}): Promise<void> {
  const client = createClient(opts);
  const list = await client.templates.list(opts.category as TemplateCategory | undefined);
  console.log(formatOutput(list, opts.output ?? "table"));
}

export async function templatesGet(id: string, opts: TemplatesOpts = {}): Promise<void> {
  const client = createClient(opts);
  const t = await client.templates.get(id);
  console.log(formatOutput(t, opts.output ?? "json"));
}
