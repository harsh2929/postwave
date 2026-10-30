import { basename } from "node:path";

import { init, parse } from "es-module-lexer";

await init;

function localJsChunk(specifier, knownChunks) {
  if (typeof specifier !== "string") return null;
  const withoutQuery = specifier.split(/[?#]/, 1)[0];
  if (!withoutQuery.endsWith(".js")) return null;
  const chunk = basename(withoutQuery);
  return knownChunks.has(chunk) ? chunk : null;
}

/** Parse emitted ESM edges, retaining local JS chunks only. */
export function parseChunkImports(source, knownChunkNames) {
  const knownChunks = new Set(knownChunkNames);
  const staticImports = new Set();
  const dynamicImports = new Set();
  const [imports] = parse(source);
  for (const entry of imports) {
    const chunk = localJsChunk(entry.n, knownChunks);
    if (!chunk) continue;
    if (entry.d === -1) staticImports.add(chunk);
    else dynamicImports.add(chunk);
  }
  return { staticImports, dynamicImports };
}

/** Build an emitted-chunk graph from a deterministic source loader. */
export function buildChunkGraph(chunkNames, loadSource) {
  const knownChunks = new Set(chunkNames);
  return new Map(
    [...knownChunks].map((chunk) => [
      chunk,
      parseChunkImports(loadSource(chunk), knownChunks),
    ]),
  );
}

/** Entry plus every recursively reachable static import, cycle-safe. */
export function collectStaticImportClosure(entry, graph) {
  if (!graph.has(entry)) throw new Error(`unknown emitted chunk ${entry}`);
  const closure = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const chunk = pending.pop();
    if (!chunk || closure.has(chunk)) continue;
    closure.add(chunk);
    for (const imported of graph.get(chunk)?.staticImports ?? []) {
      pending.push(imported);
    }
  }
  return closure;
}

/**
 * Find dynamic imports whose target is already in the importing chunk's
 * recursive static closure. These imports cannot defer download or parsing,
 * even when Rolldown's source-level warning is hidden by manualChunks.
 */
export function findIneffectiveDynamicImports(graph) {
  const collisions = [];
  for (const [chunk, imports] of graph) {
    const staticClosure = collectStaticImportClosure(chunk, graph);
    staticClosure.delete(chunk);
    for (const target of imports.dynamicImports) {
      if (staticClosure.has(target)) collisions.push({ chunk, target });
    }
  }
  return collisions.sort(
    (left, right) =>
      left.chunk.localeCompare(right.chunk) ||
      left.target.localeCompare(right.target),
  );
}

/** Locate emitted chunks by their normalized source-module ownership. */
export function findChunksOwningModule(bundleMetadata, moduleSuffix) {
  const normalizedSuffix = moduleSuffix.replaceAll("\\", "/");
  return Object.entries(bundleMetadata?.chunks ?? {})
    .filter(([, record]) =>
      Object.keys(record?.modules ?? {}).some((moduleId) =>
        moduleId.replaceAll("\\", "/").endsWith(normalizedSuffix),
      ),
    )
    .map(([chunk]) => chunk)
    .sort();
}
