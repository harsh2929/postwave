// SPDX-License-Identifier: AGPL-3.0-only
//
// Compiled binaries must not be tracked in git.
//
// Two were. Both are built from source that lives in this repo, both are
// host-architecture (Mach-O arm64) artifacts of somebody's laptop:
//
//   apps/api/engagement-corpus                          21MB  (cmd/engagement-corpus)
//   infra/observability/image/healthcheck/healthcheck    8MB  (healthcheck/main.go)
//
// .gitignore already carries rules for exactly this class — services/voice/
// tone_calibrate, the 227MB otel collector — so the convention was established
// and these two simply had no line. The collector was caught only because it
// exceeds GitHub's 100MB per-file limit; the two that slipped through are just
// small enough not to trip it, which is why a size limit is not the check.
//
// WHY IT MATTERS BEYOND TIDINESS:
//   - A binary in the tree is unreviewable. A diff shows "Bin 8119970 bytes"
//     and no human can tell a rebuild from a substitution. That is the shape of
//     a supply-chain problem, and the review process gives no purchase on it.
//   - It is architecture-specific. infra/observability/image/Dockerfile copies
//     `healthcheck/` wholesale into a build stage that compiles for
//     linux/scratch, so the committed Mach-O is dead weight the daemon uploads
//     on every build and can never execute.
//   - Every rebuild rewrites it, so the object lands in history permanently.
//
// This detects by MAGIC BYTES rather than by path, extension or size, because
// the next one will be in a directory nobody thought to list.
import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(process.cwd(), "../..");

/** Executable-format magic numbers. */
const MAGIC: Array<{ name: string; bytes: number[] }> = [
  { name: "ELF", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "Mach-O 64 LE", bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: "Mach-O 32 LE", bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { name: "Mach-O 64 BE", bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: "Mach-O universal", bytes: [0xca, 0xfe, 0xba, 0xbe] },
];

/**
 * Files git tracks, as repo-relative paths.
 *
 * Reading the INDEX rather than walking the filesystem is the whole point: an
 * untracked build artifact sitting in a working tree is normal and fine. Only
 * tracking it is the defect.
 */
function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.toString("utf8").split("\0").filter(Boolean);
}

function firstBytes(path: string, count: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(count);
    const read = readSync(fd, buf, 0, count, 0);
    return read === count ? buf : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function executableFormat(path: string): string | null {
  const head = firstBytes(path, 4);
  if (!head) return null;
  for (const { name, bytes } of MAGIC) {
    if (bytes.every((b, i) => head[i] === b)) {
      // A Java .class file also starts 0xCAFEBABE. None are tracked here, but
      // excluding by extension keeps the check honest if one ever is.
      if (name === "Mach-O universal" && path.endsWith(".class")) continue;
      return name;
    }
  }
  return null;
}

describe("no compiled binaries are tracked in git", () => {
  const tracked = trackedFiles();

  it("can read the git index", () => {
    // Guard the guard: if `git ls-files` returns nothing the sweep below is
    // vacuous and would report a clean repo forever.
    expect(tracked.length, "git ls-files returned no files").toBeGreaterThan(
      100,
    );
    expect(tracked).toContain(".gitignore");
  });

  it("detects an executable when one is present", () => {
    // Proves the magic-byte reader actually works, using a binary that is
    // present in the working tree but NOT tracked — node's own executable.
    const node = process.execPath;
    expect(
      executableFormat(node),
      `${node} should look executable`,
    ).not.toBeNull();
    expect(executableFormat(join(REPO, ".gitignore"))).toBeNull();
  });

  it("tracks no ELF or Mach-O file", () => {
    const offenders: string[] = [];
    for (const rel of tracked) {
      const abs = join(REPO, rel);
      // Read the four-byte signature first and stat only actual offenders.
      // The old two-syscall path statted every tracked file before opening
      // it, which made this repository-size audit exceed Vitest's generic
      // five-second ceiling under full-shard filesystem contention.
      const format = executableFormat(abs);
      if (!format) continue;
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        // It was readable a moment ago; retain the finding even if the file
        // disappeared before its diagnostic size could be collected.
      }
      offenders.push(`${rel} (${format}, ${Math.round(size / 1024)}KB)`);
    }
    expect(
      offenders,
      "compiled binaries in the git index — unreviewable in a diff, " +
        "architecture-specific, and permanent in history. Add a .gitignore rule " +
        "and untrack with `git rm --cached <path>`",
    ).toEqual([]);
  }, // This is intentionally proportional to the tracked repository, not to a
  // tiny unit fixture. Keep a finite ceiling while allowing loaded CI disks.
  30_000);
});
