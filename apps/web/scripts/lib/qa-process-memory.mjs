// SPDX-License-Identifier: AGPL-3.0-only
// ps reports KiB on both macOS and Linux. Count only the launched process tree.
export function descendantRssKiB(output, rootPid) {
  const rows = output
    .trim()
    .split(/\n/)
    .map((line) => line.trim().split(/\s+/).map(Number));
  const owned = new Set([rootPid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [pid, ppid] of rows) {
      if (owned.has(ppid) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
    }
  }
  return rows.reduce(
    (total, [pid, , rss]) =>
      total + (owned.has(pid) && Number.isFinite(rss) && rss >= 0 ? rss : 0),
    0,
  );
}
