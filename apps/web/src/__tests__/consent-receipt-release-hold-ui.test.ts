// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PROFILE_PANELS = readFileSync(
  resolve(
    process.cwd(),
    "src/app/(dashboard)/app/subscribers/[id]/_profile-panels.tsx",
  ),
  "utf8",
);
const DETAIL_PANELS = readFileSync(
  resolve(
    process.cwd(),
    "src/app/(dashboard)/app/subscribers/[id]/subscriber-detail-panels.tsx",
  ),
  "utf8",
);
const PROFILE_PAGE = readFileSync(
  resolve(process.cwd(), "src/app/(dashboard)/app/subscribers/[id]/page.tsx"),
  "utf8",
);
const ACTIVE_PROFILE_SURFACE = [PROFILE_PAGE, DETAIL_PANELS, PROFILE_PANELS].join(
  "\n",
);

describe("portable consent receipt release hold", () => {
  it("keeps the held consent export transport and affordance out of the active profile", () => {
    expect(ACTIVE_PROFILE_SURFACE).not.toContain("getConsentReceiptJson");
    expect(ACTIVE_PROFILE_SURFACE).not.toContain('"Consent receipt"');

    // The unrelated erasure receipt remains available; this assertion makes
    // the boundary specific instead of allowing all compliance actions to be
    // deleted to satisfy the negative checks above.
    expect(PROFILE_PANELS).toContain("getErasureReceiptJson");
    expect(PROFILE_PANELS).toContain('"Erasure receipt"');
    expect(DETAIL_PANELS).toContain("Compliance receipts");
  });
});
