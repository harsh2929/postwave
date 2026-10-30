import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RETENTION_WINBACK_RELEASE_HOLD_CODE,
  RETENTION_WINBACK_RELEASE_VERDICT,
} from "@/lib/retention-winback-release-status";

const repoRoot = join(__dirname, "..", "..", "..", "..");
const main = readFileSync(join(repoRoot, "apps", "api", "main.go"), "utf8");
const marketing = readFileSync(
  join(
    repoRoot,
    "apps",
    "web",
    "src",
    "app",
    "(marketing)",
    "automations",
    "page.tsx",
  ),
  "utf8",
);
const webDashboard = readFileSync(
  join(
    repoRoot,
    "apps",
    "web",
    "src",
    "app",
    "(dashboard)",
    "app",
    "retention",
    "page.tsx",
  ),
  "utf8",
);
const mobileStatus = readFileSync(
  join(
    repoRoot,
    "apps",
    "mobile",
    "src",
    "components",
    "retention-offers",
    "WinbackStatusCard.tsx",
  ),
  "utf8",
);
const mobileScreen = readFileSync(
  join(
    repoRoot,
    "apps",
    "mobile",
    "src",
    "components",
    "retention-offers",
    "RetentionOffersScreen.tsx",
  ),
  "utf8",
);
const mobileObservations = readFileSync(
  join(repoRoot, "apps", "mobile", "src", "lib", "retentionOffers.ts"),
  "utf8",
);
const mobileOfferRow = readFileSync(
  join(
    repoRoot,
    "apps",
    "mobile",
    "src",
    "components",
    "retention-offers",
    "OfferFunnelRow.tsx",
  ),
  "utf8",
);
const mobileOfferDetail = readFileSync(
  join(
    repoRoot,
    "apps",
    "mobile",
    "src",
    "components",
    "retention-offers",
    "RetentionOfferDetailSheet.tsx",
  ),
  "utf8",
);
const mobileReleaseStatus = readFileSync(
  join(
    repoRoot,
    "apps",
    "mobile",
    "src",
    "lib",
    "retentionWinbackReleaseStatus.ts",
  ),
  "utf8",
);
const desktopReadiness = readFileSync(
  join(
    repoRoot,
    "apps",
    "desktop",
    "src",
    "components",
    "retention",
    "RetentionHistoryReadinessPanel.tsx",
  ),
  "utf8",
);
const desktopLegacyCard = readFileSync(
  join(
    repoRoot,
    "apps",
    "desktop",
    "src",
    "components",
    "retention",
    "WinbackCard.tsx",
  ),
  "utf8",
);
const desktopLegacyHelper = readFileSync(
  join(
    repoRoot,
    "apps",
    "desktop",
    "src",
    "components",
    "retention",
    "winback-helpers.ts",
  ),
  "utf8",
);
const desktopReleaseStatus = readFileSync(
  join(
    repoRoot,
    "apps",
    "desktop",
    "src",
    "lib",
    "retention-winback-release-status.ts",
  ),
  "utf8",
);

describe("retention win-back release claim", () => {
  it("keeps outbound dispatch held while the worker is not composed", () => {
    expect(main).not.toMatch(/retention_offers\.WinbackWorker/u);
    expect(RETENTION_WINBACK_RELEASE_VERDICT).toBe("rollout-held");
    expect(RETENTION_WINBACK_RELEASE_HOLD_CODE).toBe(
      "ASSURE-F15-WINBACK-DISPATCH-UNWIRED",
    );
    expect(marketing).toContain("RETENTION_WINBACK_RELEASE_HOLD_CODE");
    expect(webDashboard).toContain("RETENTION_WINBACK_RELEASE_HOLD_CODE");
    expect(mobileStatus).toContain("RETENTION_WINBACK_RELEASE_HOLD_CODE");
    expect(mobileScreen).toContain("RETENTION_WINBACK_RELEASE_HOLD_CODE");
    expect(desktopReadiness).toContain("RETENTION_WINBACK_RELEASE_HOLD_CODE");
    expect(desktopLegacyCard).toContain("RETENTION_WINBACK_RELEASE_HOLD_CODE");
    expect(mobileReleaseStatus).toContain(RETENTION_WINBACK_RELEASE_HOLD_CODE);
    expect(desktopReleaseStatus).toContain(RETENTION_WINBACK_RELEASE_HOLD_CODE);
  });

  it("does not advertise the dormant worker as a shipped sender", () => {
    const customerAndOperatorCopy = [
      marketing,
      webDashboard,
      mobileStatus,
      mobileScreen,
      mobileObservations,
      mobileOfferRow,
      mobileOfferDetail,
      desktopReadiness,
      desktopLegacyCard,
      desktopLegacyHelper,
    ].join("\n");
    expect(customerAndOperatorCopy).not.toMatch(
      /automatic win-backs|background worker e-mails|worker e-mails a retention offer|can enter win-back|on and able to fire|are enrolled|applied through the subscriber's retention portal/iu,
    );
    expect(mobileScreen).not.toMatch(/offers are authored .* web admin/iu);
    expect(desktopLegacyCard).not.toContain("winbackSettingsApi.put");
    expect(desktopLegacyCard).not.toContain("Save win-back settings");
  });
});
