// SPDX-License-Identifier: MIT

import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export type EmailFileEvent = {
  type: "added" | "changed" | "removed";
  path: string;
};

export interface WatcherOptions {
  cwd: string;
  onEvent: (e: EmailFileEvent) => void;
  patterns?: RegExp[];
  ignored?: RegExp[];
}

const DEFAULT_PATTERNS = [/\.email\.tsx$/, /\.mjml$/];
const DEFAULT_IGNORED = [/node_modules/, /\.git/, /dist/, /\.next/];

/**
 * Recursive `fs.watch`-based watcher. Returns a stop handle. We track
 * known files so we can synthesize add/remove events from raw rename
 * notifications (the platform-level events are unreliable on Windows).
 */
export async function startWatcher(opts: WatcherOptions): Promise<() => void> {
  const patterns = opts.patterns ?? DEFAULT_PATTERNS;
  const ignored = opts.ignored ?? DEFAULT_IGNORED;
  const known = new Set<string>(await listEmailFiles(opts.cwd, patterns, ignored));

  const matches = (p: string) => patterns.some((r) => r.test(p));
  const isIgnored = (p: string) => ignored.some((r) => r.test(p));

  let watcher: FSWatcher;
  try {
    watcher = watch(opts.cwd, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      if (isIgnored(rel)) return;
      if (!matches(rel)) return;
      const abs = join(opts.cwd, rel);
      stat(abs).then(
        () => {
          if (known.has(abs)) opts.onEvent({ type: "changed", path: abs });
          else {
            known.add(abs);
            opts.onEvent({ type: "added", path: abs });
          }
        },
        () => {
          if (known.delete(abs)) opts.onEvent({ type: "removed", path: abs });
        },
      );
    });
  } catch (err) {
    throw new Error(`fs.watch failed for ${opts.cwd}: ${(err as Error).message}`);
  }

  return () => {
    try {
      watcher.close();
    } catch {
      /* noop */
    }
  };
}

export async function listEmailFiles(
  cwd: string,
  patterns: RegExp[] = DEFAULT_PATTERNS,
  ignored: RegExp[] = DEFAULT_IGNORED,
): Promise<string[]> {
  const out: string[] = [];
  await walk(cwd, cwd, patterns, ignored, out);
  return out;
}

async function walk(
  root: string,
  dir: string,
  patterns: RegExp[],
  ignored: RegExp[],
  out: string[],
): Promise<void> {
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    const rel = relative(root, abs);
    if (ignored.some((r) => r.test(rel))) continue;
    if (e.isDirectory()) await walk(root, abs, patterns, ignored, out);
    else if (e.isFile() && patterns.some((r) => r.test(rel))) out.push(abs);
  }
}
