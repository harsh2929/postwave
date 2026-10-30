// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(
    resolve(
      process.cwd(),
      "src/app/(dashboard)/app/subscribers/segments/[id]",
      file,
    ),
    "utf8",
  );
// The Members card (live members + snapshots) lives beside the page; its
// queries and its snapshot write are held to the same contract.
const page = read("page.tsx");
const membersSection = read("members-section.tsx");
const source = `${page}\n${membersSection}`;

describe("segment detail authority contract", () => {
  it("never starts protected detail queries from an unresolved or failed identity", () => {
    expect(source).toContain(
      "const identityResolved = me.isSuccess && Boolean(me.data);",
    );
    expect(source).not.toContain("enabled: Boolean(id),");
    expect(source).not.toContain("me.isFetched");
    expect(page.match(/enabled: Boolean\(id\) && identityResolved/g)).toHaveLength(
      6,
    );
    // The Members card receives identityResolved as `enabled` and gates every
    // query on it.
    expect(page).toContain("enabled={identityResolved}");
    expect(
      membersSection.match(/enabled: enabled && Boolean\((segmentId|activeSnapshotId)\)/g),
    ).toHaveLength(3);
    expect(source).toContain("No segment data was\n          requested.");
  });

  it("partitions sensitive caches and mounted local state by exact effective principal", () => {
    expect(source).toContain("me.data.user_id");
    expect(source).toContain('me.data.viewer_mode ? "viewer" : "member"');
    expect(source).toContain("query.queryKey.includes(previous)");
    expect(source).toContain("queryClient.removeQueries");
    // Keyed by segment as well, so another overview starts on page one.
    expect(source).toContain("key={`members:${principalKey}:${segment.id}`}");
    expect(source).toContain("key={`decay:${principalKey}`}");
    expect(source).toContain("key={`history:${principalKey}`}");
  });

  it("freshly reauthorizes every persistent write and uses synchronous locks", () => {
    expect(
      source.match(/await reauthorizeSubscriberMutation\(authority\);/g),
    ).toHaveLength(8);
    expect(source).toContain("if (!authority || captureRef.current) return;");
    expect(source).toContain("if (!authority || mutationRef.current) return;");
    expect(source).toContain("if (!authority || holdoutBusyRef.current) return;");
    expect(source).toContain("if (!authority || restoringRef.current) return;");
    expect(source).toContain("if (!segment || !authority || topActionRef.current) return;");
  });

  it("freezes mutable inputs before fresh authority checks and transport", () => {
    expect(source).toContain("const intent = duplicateSegmentInput");
    expect(source).toContain("queryAst: structuredClone(segment.queryAst)");
    expect(source).toContain("const intent = { segmentId, percent } as const;");
    expect(source).toContain("queryAst: structuredClone(ast)");
  });
});
