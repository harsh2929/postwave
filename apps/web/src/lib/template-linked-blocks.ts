// SPDX-License-Identifier: AGPL-3.0-only

import type { SavedBlock } from "@/lib/content-library-api";
import { savedBlockSource, type TemplateSnippetFormat } from "@/lib/template-saved-blocks";

export interface LinkedTemplateBlock {
  id: string;
  name: string;
  format: TemplateSnippetFormat;
  version: number;
  source: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readLinkedTemplateBlocks(metadata: Record<string, unknown> | undefined): LinkedTemplateBlock[] {
  const raw = metadata?.moosewave_linked_blocks;
  if (!Array.isArray(raw)) return [];
  const valid = raw.slice(0, 20).filter((item): item is LinkedTemplateBlock =>
    item !== null && typeof item === "object" &&
    UUID.test(item.id) &&
    typeof item.name === "string" && item.name.length <= 120 &&
    (item.format === "html" || item.format === "mjml") &&
    Number.isSafeInteger(item.version) && item.version > 0 &&
    typeof item.source === "string" && item.source.length > 0 && item.source.length <= 8192,
  );
  const seen = new Set<string>();
  return valid.filter((item) => {
    const key = `${item.format}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function linkedBlockOccurrenceCount(body: string, source: string): number {
  if (!source) return 0;
  return body.split(source).length - 1;
}

/** Explicit, fail-closed update: never overwrite a customized or ambiguous snippet. */
export function applyLinkedBlockUpdate(
  body: string,
  link: LinkedTemplateBlock,
  latest: SavedBlock,
): { body: string; link: LinkedTemplateBlock } | null {
  if (latest.id !== link.id || latest.version <= link.version ||
      linkedBlockOccurrenceCount(body, link.source) !== 1) return null;
  const source = savedBlockSource(latest, link.format);
  if (!source || source.length > 8192) return null;
  return {
    body: body.replace(link.source, source),
    link: { ...link, name: latest.name, version: latest.version, source },
  };
}
