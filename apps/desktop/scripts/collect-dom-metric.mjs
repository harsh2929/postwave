/**
 * Collect a stable renderer DOM counter for the cold-shell budget.
 *
 * Chromium's pre-GC `Nodes` metric includes unreachable DOM wrappers and
 * detached parser/reconciliation intermediates. Their collection is scheduled
 * nondeterministically, so identical active documents can report radically
 * different raw counts. An explicit collection keeps connected nodes and any
 * genuinely retained detached nodes in scope while removing GC timing from the
 * performance contract.
 *
 * @param {{ send(method: string): Promise<unknown> }} session
 * @returns {Promise<{documents: number, nodes: number, jsEventListeners: number}>}
 */
export async function collectGarbageCollectedDomCounters(session) {
  await session.send("HeapProfiler.collectGarbage");
  const value = await session.send("Memory.getDOMCounters");
  if (
    value === null ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.documents) ||
    value.documents < 1 ||
    !Number.isSafeInteger(value.nodes) ||
    value.nodes < 1 ||
    !Number.isSafeInteger(value.jsEventListeners) ||
    value.jsEventListeners < 0
  ) {
    throw new Error("Chromium returned invalid garbage-collected DOM counters");
  }
  return {
    documents: value.documents,
    nodes: value.nodes,
    jsEventListeners: value.jsEventListeners,
  };
}
