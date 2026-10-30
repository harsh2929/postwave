// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP = join(process.cwd(), "src/app/(dashboard)/app");
const submissions = readFileSync(
  join(APP, "forms/[id]/submissions/page.tsx"),
  "utf8",
);
const paidMembers = readFileSync(
  join(APP, "subscribers/paid-members/page.tsx"),
  "utf8",
);
const templateDetail = readFileSync(
  join(APP, "templates/[id]/page.tsx"),
  "utf8",
);

function linkClassesNear(source: string, marker: string): string[] {
  const markerIndex = source.indexOf(marker);
  expect(markerIndex, `missing link marker: ${marker}`).toBeGreaterThan(-1);

  const tagStart = source.lastIndexOf("<Link", markerIndex);
  const tagEnd = source.indexOf(">", tagStart);
  expect(tagStart, `missing Link before: ${marker}`).toBeGreaterThan(-1);
  expect(tagEnd, `unterminated Link before: ${marker}`).toBeGreaterThan(
    tagStart,
  );

  const className = /className="([^"]+)"/u.exec(
    source.slice(tagStart, tagEnd + 1),
  )?.[1];
  expect(className, `missing classes for: ${marker}`).toBeTruthy();
  return className!.split(/\s+/u);
}

function expectResponsiveTouchTarget(classes: string[]): void {
  expect(classes).toEqual(
    expect.arrayContaining(["min-h-11", "items-center", "sm:min-h-0"]),
  );
}

describe("route-specific mobile link targets", () => {
  it("gives the submissions back link and every rendered email row a 44px phone target", () => {
    expectResponsiveTouchTarget(linkClassesNear(submissions, "← {form.name}"));
    expectResponsiveTouchTarget(
      linkClassesNear(submissions, "title={`Find ${s.email} in subscribers`}"),
    );
  });

  it("gives each paid-member email a 44px phone target", () => {
    expectResponsiveTouchTarget(
      linkClassesNear(
        paidMembers,
        "href={`/app/subscribers/${encodeURIComponent(",
      ),
    );
  });

  it("gives every related-campaign link a 44px phone target", () => {
    expectResponsiveTouchTarget(
      linkClassesNear(templateDetail, '{campaign.name || "Untitled campaign"}'),
    );
  });
});
