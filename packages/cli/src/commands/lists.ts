// SPDX-License-Identifier: MIT
//
// `pw lists create` / `pw lists delete` — write-side parity for audience
// lists. Read commands (`lists list` / `lists get`) live elsewhere; these
// mirror the dashboard's "New list" and "Delete list" actions, scriptable.

import chalk from "chalk";
import type { CreateListInput } from "@postwave/sdk";
import { createClient, type ClientOpts } from "../lib/client.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";

export interface ListsWriteOpts extends ClientOpts {
  name?: string;
  type?: string;
  optin?: string;
  tags?: string;
  description?: string;
  yes?: boolean;
  output?: OutputFormat;
}

const LIST_TYPES = ["private", "public"] as const;
const LIST_OPTINS = ["single", "double"] as const;

export async function listsCreate(opts: ListsWriteOpts = {}): Promise<void> {
  let input: CreateListInput;
  try {
    input = listCreateInputFromOptions(opts);
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);
  const out = await client.lists.create(input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function listsDelete(
  id: string | undefined,
  opts: ListsWriteOpts = {},
): Promise<void> {
  const listId = (id ?? "").trim();
  if (!listId) {
    console.error("Pass a list id.");
    process.exitCode = 1;
    return;
  }
  if (!opts.yes) {
    console.error("This permanently deletes the list. Pass --yes to confirm.");
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);
  await client.lists.delete(listId);
  console.log(chalk.green(`Deleted list ${listId}.`));
}

export function listCreateInputFromOptions(opts: ListsWriteOpts): CreateListInput {
  const name = (opts.name ?? "").trim();
  if (!name) throw new Error("Pass --name <name> to create a list.");
  const input: CreateListInput = { name };
  const type = optionalEnum(opts.type, LIST_TYPES, "--type");
  if (type) input.type = type;
  const optin = optionalEnum(opts.optin, LIST_OPTINS, "--optin");
  if (optin) input.optin = optin;
  const tags = parseTags(opts.tags);
  if (tags) input.tags = tags;
  const description = (opts.description ?? "").trim();
  if (description) input.description = description;
  return input;
}

function parseTags(value: string | undefined): string[] | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return undefined;
  return trimmed
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function optionalEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  label: string,
): T | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return undefined;
  if ((allowed as readonly string[]).includes(trimmed)) return trimmed as T;
  throw new Error(`Pass ${label} as one of: ${allowed.join(", ")}.`);
}
