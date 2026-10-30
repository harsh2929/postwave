/**
 * The two rows the campaign subject sheet grew for desktop parity:
 *
 *   P2.7 — CampaignAbFromNamesField, the G14 multivariate axis (from-names
 *          crossed with the AI subject variants, ≤8 combos);
 *   P2.8 — CampaignSubjectLabLink, the seed into Subject Lab that arms the
 *          lab → bandit handoff against this campaign.
 *
 * The rules (parse, cap, payload; seed grammar) are vitest-pinned in
 * src/lib/campaignAbVariants.test.ts and src/lib/subjectLabSeed.test.ts. What
 * only a render can pin is the SURFACE contract: the caption says what the
 * cross-product will be BEFORE the tap, the cap warning replaces it, and the
 * link pushes exactly the params the lab decodes — after closing the sheet.
 *
 * Rendered via RELATIVE imports: jest.routes.config.cjs maps
 * `@/components/campaigns/*` to a null stub to keep route-suite composition
 * cheap, and a stub would make every assertion here vacuous. (The field's own
 * CampaignFieldInput leaf stays stubbed; the caption is what is under test.)
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";

import { CampaignAbFromNamesField } from "../src/components/campaigns/CampaignAbFromNamesField";
import { CampaignSubjectLabLink } from "../src/components/campaigns/CampaignSubjectLabLink";

describe("A/B from-name variants (P2.7)", () => {
  it("explains the axis while it is empty", async () => {
    await render(
      <CampaignAbFromNamesField value="" onChangeText={jest.fn()} subjectCount={3} />,
    );
    expect(
      screen.getByText(/Optional: one from-name per line\. With 2\+ names/),
    ).toBeTruthy();
  });

  it("says a single name is a sender, not an axis", async () => {
    await render(
      <CampaignAbFromNamesField
        value="Acme Team"
        onChangeText={jest.fn()}
        subjectCount={2}
      />,
    );
    expect(
      screen.getByText(/One from-name is used as the sender for every variant/),
    ).toBeTruthy();
  });

  it("states the cross-product before the tap, blanks dropped", async () => {
    await render(
      <CampaignAbFromNamesField
        value={"Acme Team\n\n  Jane at Acme  \n"}
        onChangeText={jest.fn()}
        subjectCount={3}
      />,
    );
    expect(
      screen.getByText("3 subjects × 2 from-names = 6 variants (capped at 8)."),
    ).toBeTruthy();
  });

  it("replaces the caption with the cap warning past 8 combinations", async () => {
    await render(
      <CampaignAbFromNamesField
        value={"A\nB\nC"}
        onChangeText={jest.fn()}
        subjectCount={3}
      />,
    );
    // 3 × 3 = 9 > abMaxCombos (abtest.go:80): the server would 400, so the
    // row says so here and the hand-off hook refuses before the POST.
    expect(screen.getByText(/9 combinations/)).toBeTruthy();
    expect(screen.getByText(/caps a test at 8/)).toBeTruthy();
    expect(screen.queryByText(/= 9 variants/)).toBeNull();
  });
});

describe("Score in Subject Lab (P2.8)", () => {
  it("closes the sheet and pushes the lab with the seed grammar", async () => {
    const onNavigate = jest.fn();
    await render(
      <CampaignSubjectLabLink
        subject="  Your April report is ready  "
        campaignId="cmp_1"
        onNavigate={onNavigate}
      />,
    );
    await fireEvent.press(
      screen.getByLabelText("Score this subject in Subject Lab"),
    );
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/(tabs)/subject-lab",
      params: { seed: "Your April report is ready", campaignId: "cmp_1" },
    });
    // The sheet closes BEFORE the push, or the tab opens behind it.
    const closeOrder = (onNavigate as jest.Mock).mock.invocationCallOrder[0];
    const pushOrder = (router.push as jest.Mock).mock.invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(pushOrder as number);
  });
});
