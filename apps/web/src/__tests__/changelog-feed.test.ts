// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { GET } from "@/app/changelog.xml/route";

describe("changelog Atom feed", () => {
  it("contains only the releases marked shipped on the changelog page", async () => {
    const response = GET();
    const xml = await response.text();

    expect(response.headers.get("content-type")).toContain(
      "application/atom+xml",
    );
    for (const version of ["v0.4.0", "v0.3.1", "v0.3.0", "v0.2.1", "v0.0.4"]) {
      expect(xml).toContain(`changelog/${version}`);
    }
    for (const planned of [
      "v0.2.0",
      "v0.1.0-beta",
      "v0.0.3",
      "v0.0.2",
      "v0.0.1",
    ]) {
      expect(xml).not.toContain(`changelog/${planned}`);
    }
    expect(xml).not.toContain("2026-09-01");
  });
});
